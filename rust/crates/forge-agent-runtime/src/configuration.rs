//! Explicit operator configuration, with no environment loading or provider IO
//! during construction. Sandbox resources are created lazily inside a leased run.
use crate::{
    Error, Result,
    auth::Channel,
    callback::{HttpCapabilities, PeerIdentity},
    engine::{Engine, State},
    execution::Features,
    model::transport::HttpModel,
    sandbox::{Cancellation, Execution, Sandbox},
    tools::Executor,
    vercel, worker,
};
use async_trait::async_trait;
use std::{collections::HashMap, sync::Arc};
use tokio::{io::AsyncReadExt, sync::Mutex};
use url::Url;

pub struct ConfiguredFactory {
    model: Arc<HttpModel>,
    capabilities: Arc<HttpCapabilities>,
    sandbox: Option<Arc<vercel::Factory>>,
    features: Features,
    input_limit: u64,
    output_limit: u64,
}
struct Identity {
    file: Option<String>,
    token: Option<String>,
}
#[async_trait]
impl PeerIdentity for Identity {
    async fn token(&self) -> Result<String> {
        let value = if let Some(path) = &self.file {
            let file = tokio::fs::File::open(path)
                .await
                .map_err(|_| Error("The configured service identity is unavailable."))?;
            let mut bytes = vec![];
            file.take(128 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| Error("The configured service identity is unavailable."))?;
            if bytes.len() > 128 * 1024 {
                return Err(Error(
                    "The configured service identity exceeds its size limit.",
                ));
            }
            String::from_utf8(bytes)
                .map_err(|_| Error("The configured service identity is invalid."))?
        } else {
            self.token
                .clone()
                .ok_or(Error("The configured service identity is unavailable."))?
        };
        let value = forge_core::text::trim(&value);
        if value.is_empty() {
            return Err(Error("The configured service identity is unavailable."));
        }
        Ok(value.to_owned())
    }
}
fn value<'a>(env: &'a HashMap<String, String>, key: &str) -> &'a str {
    env.get(key).map(String::as_str).unwrap_or("")
}
fn identity(env: &HashMap<String, String>) -> Result<Arc<dyn PeerIdentity>> {
    let file = value(env, "VERCEL_OIDC_TOKEN_FILE");
    let token = value(env, "VERCEL_OIDC_TOKEN");
    if file.is_empty() && token.is_empty() {
        return Err(Error("A configured platform identity is required."));
    }
    Ok(Arc::new(Identity {
        file: (!file.is_empty()).then(|| file.to_owned()),
        token: (!token.is_empty()).then(|| token.to_owned()),
    }))
}
impl ConfiguredFactory {
    pub fn new(env: &HashMap<String, String>) -> Result<Self> {
        let origin = Url::parse(value(env, "FORGE_APP_ORIGIN"))
            .map_err(|_| Error("The Forge application origin is invalid."))?;
        if origin.path() != "/" || origin.query().is_some() || origin.fragment().is_some() {
            return Err(Error(
                "Configure an application origin without a path, query or fragment.",
            ));
        }
        let peer = if !value(env, "FORGE_RUST_RUNTIME_PEER_ORIGIN").is_empty() {
            let peer = Url::parse(value(env, "FORGE_RUST_RUNTIME_PEER_ORIGIN"))
                .map_err(|_| Error("The reviewed application peer origin is invalid."))?;
            if peer.origin() != origin.origin() {
                return Err(Error(
                    "The service identity is not authorized for this application origin.",
                ));
            }
            Some((peer, identity(env)?))
        } else {
            None
        };
        let flags = forge_core::agents::policy::features(env);
        let features = Features {
            code_mode: flags["agent_code_mode"] == true,
            programmatic_tools: flags["agent_programmatic_tools"] == true,
            write_tools: flags["agent_write_tools"] == true,
        };
        let sandbox = match value(env, "FORGE_RUST_RUNTIME_SANDBOX") {
            "vercel" => Some(Arc::new(vercel::Factory::new(
                vercel::Options {
                    team_id: value(env, "VERCEL_TEAM_ID").into(),
                    project_id: value(env, "VERCEL_PROJECT_ID").into(),
                    lifetime_ms: 900_000,
                },
                identity(env)?,
            )?)),
            "" | "disabled" if !features.code_mode => None,
            "" | "disabled" => {
                return Err(Error(
                    "Code mode requires an explicitly configured isolated sandbox backend.",
                ));
            }
            _ => {
                return Err(Error(
                    "The requested native sandbox backend is not implemented.",
                ));
            }
        };
        let controls = forge_core::agents::policy::controls(env);
        Ok(Self {
            model: Arc::new(HttpModel::new(origin.clone(), peer.clone())?),
            capabilities: Arc::new(HttpCapabilities::new(origin, peer)?),
            sandbox,
            features,
            input_limit: controls["maxInputTokens"].as_u64().unwrap(),
            output_limit: controls["maxOutputTokens"].as_u64().unwrap(),
        })
    }
}
#[async_trait]
impl worker::Factory for ConfiguredFactory {
    async fn create(&self, _: &Channel, _: &State, cancellation: &Cancellation) -> Result<Engine> {
        if cancellation.is_cancelled() {
            return Err(Error("The runtime worker has stopped."));
        }
        let sandbox = self.sandbox.as_ref().map(|factory| {
            Arc::new(LazySandbox {
                factory: factory.clone(),
                inner: Mutex::new(None),
            }) as Arc<dyn Sandbox>
        });
        let mut engine = Engine::new(
            self.model.clone(),
            Arc::new(Executor {
                capabilities: self.capabilities.clone(),
                sandbox,
                features: self.features,
            }),
        );
        engine.max_input_tokens = self.input_limit;
        engine.max_output_tokens = self.output_limit;
        Ok(engine)
    }
}
struct LazySandbox {
    factory: Arc<vercel::Factory>,
    inner: Mutex<Option<Arc<vercel::VercelSandbox>>>,
}
impl LazySandbox {
    async fn get(&self) -> Result<Arc<vercel::VercelSandbox>> {
        let mut inner = self.inner.lock().await;
        if inner.is_none() {
            *inner = Some(self.factory.create().await?);
        }
        Ok(inner.as_ref().unwrap().clone())
    }
}
#[async_trait]
impl Sandbox for LazySandbox {
    async fn write(&self, path: &str, content: &str) -> Result<()> {
        self.get().await?.write(path, content).await
    }
    async fn run(&self, command: &str) -> Result<Execution> {
        self.get().await?.run(command).await
    }
    async fn remove(&self, path: &str) -> Result<()> {
        // Cleanup must never create a new provider resource.
        let inner = self.inner.lock().await.clone();
        if let Some(inner) = inner {
            inner.remove(path).await
        } else {
            Ok(())
        }
    }
}

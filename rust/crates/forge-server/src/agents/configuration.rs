use super::*;
use crate::agent_runtime::{EveRuntime, Options, PeerIdentity};
use async_trait::async_trait;
use forge_core::agents::runtime::{self, Runtime};
use std::collections::HashMap;
use tokio::io::AsyncReadExt;
use url::Url;

struct PlatformIdentity {
    file: Option<String>,
    token: Option<String>,
}
#[async_trait]
impl PeerIdentity for PlatformIdentity {
    async fn token(&self) -> Result<String, runtime::Error> {
        // Read a mounted, rotating identity each time. No incoming user header
        // is trusted as a platform identity and no refresh login is attempted.
        let token = if let Some(path) = &self.file {
            let file = tokio::fs::File::open(path)
                .await
                .map_err(|_| runtime::Error("The platform identity is unavailable."))?;
            let mut bytes = Vec::new();
            file.take(128 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| runtime::Error("The platform identity is unavailable."))?;
            if bytes.len() > 128 * 1024 {
                return Err(runtime::Error(
                    "The platform identity exceeds its size limit.",
                ));
            }
            String::from_utf8(bytes)
                .map_err(|_| runtime::Error("The platform identity is invalid."))?
        } else {
            self.token
                .clone()
                .ok_or(runtime::Error("The platform identity is unavailable."))?
        };
        let token = forge_core::text::trim(&token);
        if token.is_empty() {
            return Err(runtime::Error("The platform identity is unavailable."));
        }
        Ok(token.into())
    }
}
fn value<'a>(env: &'a HashMap<String, String>, key: &str) -> &'a str {
    env.get(key).map(String::as_str).unwrap_or("")
}
fn reviewed_peer(env: &HashMap<String, String>) -> Result<Option<Url>, &'static str> {
    if value(env, "FORGE_RESOURCE_PROFILE") == "preview" {
        if value(env, "VERCEL_ENV") != "preview"
            || value(env, "VERCEL_PROJECT_ID") != "prj_S0XLtdngbexhl2ao7WviBrlMScar"
        {
            return Err("The preview web identity is not configured.");
        }
        let projects = forge_core::json::parse(value(env, "VERCEL_RELATED_PROJECTS"))
            .map_err(|_| "The preview runtime peer is unavailable.")?;
        let entries = projects
            .as_array()
            .ok_or("The preview runtime peer is unavailable.")?;
        let matches: Vec<_> = entries
            .iter()
            .filter(|v| v["project"]["id"] == "prj_w8c0FjUTbQ4UT71O48t9zvC00bFS")
            .collect();
        if matches.len() != 1 {
            return Err("The preview runtime peer is ambiguous.");
        }
        let host = matches[0]["preview"]["branch"]
            .as_str()
            .ok_or("The preview runtime peer is unavailable.")?;
        let valid = host.strip_suffix(".vercel.app").is_some_and(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
        if !valid {
            return Err("The preview runtime origin is not allowed.");
        }
        return Ok(Some(
            Url::parse(&format!("https://{host}"))
                .map_err(|_| "The preview runtime origin is invalid.")?,
        ));
    }
    if value(env, "FORGE_ENVIRONMENT") == "staging" {
        if value(env, "VERCEL_PROJECT_ID") != "prj_undcmz4aPiL4FuTc69hQoPwWYead" {
            return Err("The staging web identity is not configured.");
        }
        return Ok(Some(
            Url::parse("https://forge-staging-runtime-matthieu-pm.vercel.app").unwrap(),
        ));
    }
    Ok(None)
}
impl Settings {
    pub fn configured(
        database: forge_store::Database,
        storage: crate::files::storage::Storage,
        env: &HashMap<String, String>,
    ) -> Result<Self, &'static str> {
        let features = policy::features(env);
        let controls = policy::controls(env);
        let mut models = crate::model_proxy::configured_connections(database.clone(), env);
        models.allowed_providers = Some(
            forge_core::agents::PROVIDERS
                .iter()
                .filter(|provider| {
                    policy::provider_enabled(&features, provider)
                        && controls["allowedProviders"]
                            .as_array()
                            .is_none_or(|allowed| allowed.iter().any(|v| v == *provider))
                })
                .map(|s| (*s).into())
                .collect(),
        );
        let models = Arc::new(models);
        let mut files =
            forge_store::agents::files::Service::new(database.clone(), Arc::new(storage));
        files.settings = forge_core::agents::files::Settings::from_environment(env);
        let files = Arc::new(files);
        let peer = reviewed_peer(env)?;
        let origin = if value(env, "FORGE_RESOURCE_PROFILE") == "preview" {
            peer.as_ref().map(ToString::to_string)
        } else {
            env.get("EVE_AGENT_RUNTIME_URL")
                .filter(|v| !v.is_empty())
                .cloned()
        };
        let mut runtimes: Vec<Arc<dyn Runtime>> = vec![];
        if features["agent_eve_runtime"] == true && origin.is_some() {
            if !value(env, "FORGE_AGENT_CHANNEL_SECRET").is_empty() {
                for key in [
                    "FORGE_AGENT_CHANNEL_SECRET",
                    "FORGE_AGENT_CAPABILITY_SECRET",
                    "FORGE_AGENT_MODEL_ACCESS_SECRET",
                ] {
                    if value(env, key).encode_utf16().count() < 32 {
                        return Err(
                            "Agent runtime signing secrets must contain at least 32 characters.",
                        );
                    }
                }
                let base_url = Url::parse(origin.as_deref().unwrap())
                    .map_err(|_| "The agent runtime URL is invalid.")?;
                if peer
                    .as_ref()
                    .is_some_and(|peer| peer.origin() != base_url.origin())
                {
                    return Err("The agent runtime does not match the reviewed service peer.");
                }
                let identity = peer.as_ref().map(|_| {
                    Arc::new(PlatformIdentity {
                        file: env
                            .get("VERCEL_OIDC_TOKEN_FILE")
                            .filter(|s| !s.is_empty())
                            .cloned(),
                        token: env
                            .get("VERCEL_OIDC_TOKEN")
                            .filter(|s| !s.is_empty())
                            .cloned(),
                    }) as Arc<dyn PeerIdentity>
                });
                runtimes.push(Arc::new(
                    EveRuntime::new(Options {
                        base_url,
                        channel_secret: value(env, "FORGE_AGENT_CHANNEL_SECRET").into(),
                        capability_secret: value(env, "FORGE_AGENT_CAPABILITY_SECRET").into(),
                        model_secret: value(env, "FORGE_AGENT_MODEL_ACCESS_SECRET").into(),
                        peer_origin: peer,
                        peer_identity: identity,
                        now: Arc::new(|| chrono::Utc::now().timestamp()),
                    })
                    .map_err(|_| "The agent runtime configuration is invalid.")?,
                ));
            }
        } else if value(env, "AGENT_FAKE_RUNTIME_ENABLED") == "true" {
            if value(env, "FORGE_RESOURCE_PROFILE") == "preview"
                || value(env, "FORGE_ENVIRONMENT") == "staging"
            {
                return Err("Fixture agent execution is not allowed in staging or preview.");
            }
            runtimes.push(Arc::new(FixtureRuntime));
        }
        let mut coordinator = Service::new(database.clone());
        coordinator.controls = controls.clone();
        coordinator.attachments = Some(files.clone());
        let mut hosted = forge_store::agents::coordinator::Hosted::new(models.clone(), runtimes);
        hosted.features = features.clone();
        coordinator.hosted = Some(Arc::new(hosted));
        let mut settings = Self::new(coordinator, models);
        settings.features = features;
        settings.local_secret = value(env, "FORGE_AGENT_LOCAL_INGEST_SECRET").into();
        settings.capability_secret = value(env, "FORGE_AGENT_CAPABILITY_SECRET").into();
        settings.artifact_secret = env
            .get("FORGE_AGENT_ARTIFACT_SECRET")
            .filter(|s| !s.is_empty())
            .map(String::as_str)
            .unwrap_or(&settings.capability_secret)
            .into();
        settings.capabilities = Gateway::new(database).with_artifacts(files).with_allowed(
            controls["allowedCapabilities"].as_array().map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(str::to_owned))
                    .collect()
            }),
        );
        Ok(settings)
    }
}
struct FixtureRuntime;
#[async_trait]
impl Runtime for FixtureRuntime {
    fn kind(&self) -> &'static str {
        "eve"
    }
    fn start(&self, c: runtime::Context, _: String, _: Vec<Value>) -> runtime::Events {
        Box::pin(futures_util::stream::iter([
            Ok(
                json!({"sourceEventId":format!("{}:delta:1",c.run_id),"source":"eve","type":"assistant.delta","payload":{"messageId":"assistant-1","delta":"Done"}}),
            ),
            Ok(
                json!({"sourceEventId":format!("{}:message:1",c.run_id),"source":"eve","type":"assistant.message","payload":{"messageId":"assistant-1","content":"Done"}}),
            ),
        ]))
    }
    fn resume(&self, c: runtime::Context, _: Vec<Value>) -> runtime::Events {
        Box::pin(futures_util::stream::iter([Ok(
            json!({"sourceEventId":format!("{}:resumed:message:1",c.run_id),"source":"eve","type":"assistant.message","payload":{"messageId":"assistant-resumed-1","content":"Continued"}}),
        )]))
    }
    fn reconnect(&self, _: runtime::Context) -> runtime::Events {
        Box::pin(futures_util::stream::iter([Err(runtime::Error(
            "Fixture runtime reconnection is unavailable.",
        ))]))
    }
    async fn cancel(
        &self,
        _: &str,
        _: Option<&str>,
        _: Option<&runtime::Context>,
    ) -> Result<(), runtime::Error> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_identity_never_falls_back_to_an_unreviewed_preview_or_staging_peer() {
        let mut env = HashMap::from([
            ("FORGE_RESOURCE_PROFILE".into(), "preview".into()),
            ("VERCEL_ENV".into(), "preview".into()),
            (
                "VERCEL_PROJECT_ID".into(),
                "prj_S0XLtdngbexhl2ao7WviBrlMScar".into(),
            ),
            (
                "EVE_AGENT_RUNTIME_URL".into(),
                "https://production.invalid".into(),
            ),
        ]);
        assert!(reviewed_peer(&env).is_err());
        for host in [
            "preview-runtime.vercel.app",
            "evil.example",
            "preview.vercel.app.evil.example",
            "preview.vercel.app/path",
            "UPPER.vercel.app",
        ] {
            env.insert("VERCEL_RELATED_PROJECTS".into(),json!([{"project":{"id":"prj_w8c0FjUTbQ4UT71O48t9zvC00bFS"},"preview":{"branch":host}}]).to_string());
            assert_eq!(
                reviewed_peer(&env).is_ok(),
                host == "preview-runtime.vercel.app"
            );
        }
        env.insert("VERCEL_RELATED_PROJECTS".into(),json!([{"project":{"id":"prj_w8c0FjUTbQ4UT71O48t9zvC00bFS"},"preview":{"branch":"one.vercel.app"}},{"project":{"id":"prj_w8c0FjUTbQ4UT71O48t9zvC00bFS"},"preview":{"branch":"two.vercel.app"}}]).to_string());
        assert!(reviewed_peer(&env).is_err());
        env.remove("FORGE_RESOURCE_PROFILE");
        env.insert("FORGE_ENVIRONMENT".into(), "staging".into());
        assert!(reviewed_peer(&env).is_err());
        env.insert(
            "VERCEL_PROJECT_ID".into(),
            "prj_undcmz4aPiL4FuTc69hQoPwWYead".into(),
        );
        assert_eq!(
            reviewed_peer(&env)
                .unwrap()
                .unwrap()
                .origin()
                .ascii_serialization(),
            "https://forge-staging-runtime-matthieu-pm.vercel.app"
        );
    }
    #[tokio::test]
    async fn platform_identity_reads_rotated_files_and_rejects_empty_or_oversized_content() {
        let path = std::env::temp_dir().join(format!("forge-oidc-fixture-{}", Uuid::new_v4()));
        let provider = PlatformIdentity {
            file: Some(path.to_string_lossy().into_owned()),
            token: Some("unused-environment-token".into()),
        };
        for token in ["first-fixture-token", "second-fixture-token"] {
            tokio::fs::write(&path, format!(" {token}\n"))
                .await
                .unwrap();
            assert_eq!(provider.token().await.unwrap(), token);
        }
        tokio::fs::write(&path, " ").await.unwrap();
        assert!(provider.token().await.is_err());
        tokio::fs::write(&path, vec![b'a'; 128 * 1024 + 1])
            .await
            .unwrap();
        assert!(provider.token().await.is_err());
        tokio::fs::remove_file(&path).await.unwrap();
        assert!(provider.token().await.is_err());
    }
}

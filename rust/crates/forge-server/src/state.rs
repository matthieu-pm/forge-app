use crate::mail::VerificationMailer;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use url::Url;

pub struct AuthSettings {
    pub(crate) secret: String,
    pub(crate) invite_secret: String,
    pub(crate) base_url: Url,
    pub(crate) secure_cookies: bool,
}

impl AuthSettings {
    pub fn new(secret: String, base_url: &str) -> Result<Self, &'static str> {
        if secret.len() < 32 {
            return Err("BETTER_AUTH_SECRET must contain at least 32 bytes.");
        }
        let base_url = Url::parse(base_url).map_err(|_| "BETTER_AUTH_URL must be a valid URL.")?;
        if !["http", "https"].contains(&base_url.scheme())
            || base_url.host_str().is_none()
            || !base_url.username().is_empty()
            || base_url.password().is_some()
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(
                "BETTER_AUTH_URL must be an HTTP origin without credentials, query or fragment.",
            );
        }
        let secure_cookies = base_url.scheme() == "https";
        Ok(Self {
            invite_secret: secret.clone(),
            secret,
            base_url,
            secure_cookies,
        })
    }

    pub fn with_invite_secret(mut self, secret: String) -> Result<Self, &'static str> {
        if secret.encode_utf16().count() < 32 {
            return Err("FORGE_INVITE_LINK_SECRET must contain at least 32 characters.");
        }
        self.invite_secret = secret;
        Ok(self)
    }

    pub(crate) fn trusted_origin(&self, origin: &str) -> bool {
        origin == self.base_url.origin().ascii_serialization()
            || ["com.forge.desktop:/", "com.forge.desktop.dev:/"].contains(&origin)
    }

    pub(crate) fn callback(&self, callback: &str) -> Result<Url, &'static str> {
        let result = self
            .base_url
            .join(callback)
            .map_err(|_| "Invalid callback URL.")?;
        if result.origin() != self.base_url.origin() {
            return Err("Invalid callback URL.");
        }
        Ok(result)
    }

    pub(crate) fn cookie_name(&self) -> &'static str {
        if self.secure_cookies {
            "__Secure-better-auth.session_token"
        } else {
            "better-auth.session_token"
        }
    }

    pub(crate) fn cookie(&self, signed: &str, remember: bool) -> String {
        format!(
            "{}={signed}; Path=/; HttpOnly; SameSite=Lax{}{}",
            self.cookie_name(),
            if self.secure_cookies { "; Secure" } else { "" },
            if remember { "; Max-Age=604800" } else { "" }
        )
    }

    pub(crate) fn expired_cookie(&self) -> String {
        format!(
            "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
            self.cookie_name(),
            if self.secure_cookies { "; Secure" } else { "" }
        )
    }
}

#[derive(Default)]
pub(crate) struct Throttle(Mutex<HashMap<String, (Instant, u32)>>);

impl Throttle {
    pub fn allow(&self, key: String, window_seconds: u64, maximum: u32) -> bool {
        let Ok(mut entries) = self.0.lock() else {
            return false;
        };
        let now = Instant::now();
        entries.retain(|_, (started, _)| now.duration_since(*started).as_secs() < 60);
        let entry = entries.entry(key).or_insert((now, 0));
        if now.duration_since(entry.0).as_secs() >= window_seconds {
            *entry = (now, 0);
        }
        if entry.1 >= maximum {
            return false;
        }
        entry.1 += 1;
        true
    }
}

#[derive(Clone, Default)]
pub struct AppState {
    pub(crate) sla_scheduler: Option<Arc<crate::retention::Settings>>,
    pub(crate) issue_retention: Option<Arc<crate::retention::Settings>>,
    pub(crate) files: Option<Arc<crate::files::Services>>,
    pub(crate) pool: Option<forge_store::Database>,
    pub(crate) auth: Option<Arc<AuthSettings>>,
    pub(crate) mailer: Option<Arc<dyn VerificationMailer>>,
    pub(crate) throttle: Arc<Throttle>,
    pub(crate) oauth: Option<Arc<crate::oauth_provider::ChatGptClient>>,
    pub(crate) dns: Option<Arc<dyn forge_store::security::TxtResolver>>,
    pub(crate) public_api: Option<bool>,
}

impl AppState {
    pub fn configured(
        pool: PgPool,
        auth: AuthSettings,
        mailer: Option<Arc<dyn VerificationMailer>>,
    ) -> Self {
        Self::configured_database(forge_store::Database::new(pool), auth, mailer)
    }

    pub fn configured_database(
        pool: forge_store::Database,
        auth: AuthSettings,
        mailer: Option<Arc<dyn VerificationMailer>>,
    ) -> Self {
        Self {
            pool: Some(pool),
            auth: Some(Arc::new(auth)),
            mailer,
            throttle: Arc::default(),
            oauth: None,
            dns: None,
            public_api: None,
            files: None,
            issue_retention: None,
            sla_scheduler: None,
        }
    }

    pub fn with_files(mut self, storage: crate::files::storage::Storage, secret: String) -> Self {
        if let Some(database) = self.pool.clone() {
            self.files = Some(Arc::new(crate::files::Services::new(
                database, storage, secret,
            )));
        }
        self
    }
    pub fn with_issue_retention(mut self, enabled: bool, secret: String) -> Self {
        self.issue_retention = Some(Arc::new(crate::retention::Settings { enabled, secret }));
        self
    }
    pub fn with_sla_scheduler(mut self, enabled: bool, secret: String) -> Self {
        self.sla_scheduler = Some(Arc::new(crate::retention::Settings { enabled, secret }));
        self
    }
    pub fn with_chatgpt(mut self, client: crate::oauth_provider::ChatGptClient) -> Self {
        self.oauth = Some(Arc::new(client));
        self
    }
    pub fn with_dns(mut self, resolver: Arc<dyn forge_store::security::TxtResolver>) -> Self {
        self.dns = Some(resolver);
        self
    }
    pub fn with_public_api(mut self, enabled: bool) -> Self {
        self.public_api = Some(enabled);
        self
    }
}

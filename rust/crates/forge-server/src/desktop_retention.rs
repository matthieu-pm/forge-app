//! Explicit R2 deletion transport for expired desktop drafts. Credentials never
//! come from ambient SDK discovery, and provider responses are not exposed.
use aws_sdk_s3::{
    Client,
    config::{Credentials, Region},
    types::{Delete, ObjectIdentifier},
};
use forge_store::retention::{DesktopBlobs, Error};
use std::{collections::HashMap, time::Duration};
use url::Url;
pub struct Storage {
    client: Client,
    bucket: String,
}
impl Storage {
    pub fn configured(env: &HashMap<String, String>) -> Result<Option<Self>, &'static str> {
        match env
            .get("FORGE_DESKTOP_RELEASE_ENABLED")
            .map(String::as_str)
            .unwrap_or("")
        {
            "" | "false" => return Ok(None),
            "true" => {}
            _ => return Err("INVALID_CONFIGURATION"),
        }
        let required = |key: &str| {
            env.get(key)
                .map(|v| forge_core::text::trim(v))
                .filter(|v| !v.is_empty())
                .ok_or("INVALID_CONFIGURATION")
        };
        let endpoint = if let Some(endpoint) = env.get("R2_ENDPOINT").filter(|v| !v.is_empty()) {
            endpoint.clone()
        } else {
            let id = required("R2_ACCOUNT_ID")?;
            if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                return Err("INVALID_CONFIGURATION");
            }
            format!("https://{id}.r2.cloudflarestorage.com")
        };
        let endpoint = Url::parse(&endpoint).map_err(|_| "INVALID_CONFIGURATION")?;
        if endpoint.scheme() != "https" {
            return Err("INVALID_CONFIGURATION");
        }
        Self::new(
            endpoint,
            required("R2_DESKTOP_RELEASE_BUCKET")?.into(),
            required("R2_ACCESS_KEY_ID")?.into(),
            required("R2_SECRET_ACCESS_KEY")?.into(),
        )
        .map(Some)
    }
    /// A loopback endpoint permits isolated provider protocol acceptance tests.
    pub fn new(
        endpoint: Url,
        bucket: String,
        key: String,
        secret: String,
    ) -> Result<Self, &'static str> {
        if endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !(endpoint.scheme() == "https"
                || endpoint.scheme() == "http" && endpoint.host_str() == Some("127.0.0.1"))
            || [bucket.as_str(), key.as_str(), secret.as_str()]
                .iter()
                .any(|v| forge_core::text::trim(v).is_empty())
        {
            return Err("INVALID_CONFIGURATION");
        }
        let config = aws_sdk_s3::config::Builder::new()
            .behavior_version_latest()
            .region(Region::new("auto"))
            .endpoint_url(endpoint.as_str())
            .credentials_provider(Credentials::new(
                key,
                secret,
                None,
                None,
                "forge-desktop-retention",
            ))
            .force_path_style(true)
            .request_checksum_calculation(
                aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired,
            )
            .response_checksum_validation(
                aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired,
            )
            .retry_config(aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(3))
            .build();
        Ok(Self {
            client: Client::from_conf(config),
            bucket,
        })
    }
}
#[async_trait::async_trait]
impl DesktopBlobs for Storage {
    async fn delete(&self, keys: &[String]) -> Result<(), Error> {
        if keys.is_empty()
            || keys.len() > 1000
            || keys.iter().any(|v| v.is_empty() || v.len() > 1024)
        {
            return Err(Error);
        }
        let objects = keys
            .iter()
            .map(|key| {
                ObjectIdentifier::builder()
                    .key(key)
                    .build()
                    .map_err(|_| Error)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let delete = Delete::builder()
            .set_objects(Some(objects))
            .quiet(true)
            .build()
            .map_err(|_| Error)?;
        let response = tokio::time::timeout(
            Duration::from_secs(30),
            self.client
                .delete_objects()
                .bucket(&self.bucket)
                .delete(delete)
                .send(),
        )
        .await
        .map_err(|_| Error)?
        .map_err(|_| Error)?;
        if !response.errors().is_empty() {
            return Err(Error);
        }
        Ok(())
    }
}

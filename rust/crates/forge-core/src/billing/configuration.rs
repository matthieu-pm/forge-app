use super::*;
use serde::Serialize;
use std::collections::HashMap;
#[derive(Serialize)]
#[serde(untagged)]
pub enum Config {
    Disabled { enabled: bool },
    Enabled(Box<Enabled>),
}
// Deliberately no Debug on credential-bearing configuration.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Enabled {
    pub enabled: bool,
    pub environment: String,
    pub access_token: String,
    pub webhook_secret: String,
    pub paid_products: Value,
    pub app_url: String,
}
pub fn read(env: &HashMap<String, String>) -> Result<Config> {
    match env.get("FORGE_BILLING_ENABLED").map(String::as_str) {
        None | Some("false") => return Ok(Config::Disabled { enabled: false }),
        Some("true") => {}
        _ => return Err(Error("INVALID_BILLING_CONFIGURATION")),
    }
    let get = |key: &str| env.get(key).ok_or(Error("INVALID_BILLING_CONFIGURATION"));
    let environment = get("POLAR_ENVIRONMENT")?;
    if !["sandbox", "production"].contains(&environment.as_str()) {
        return Err(Error("INVALID_BILLING_CONFIGURATION"));
    }
    let access = crate::text::trim(get("POLAR_ACCESS_TOKEN")?);
    let webhook = crate::text::trim(get("POLAR_WEBHOOK_SECRET")?);
    if access.is_empty() || webhook.is_empty() {
        return Err(Error("INVALID_BILLING_CONFIGURATION"));
    }
    let mut products = json!({"starter":{},"plus":{}});
    for plan in ["starter", "plus"] {
        for currency in ["eur", "usd"] {
            let id = get(&format!(
                "POLAR_{}_{}_PRODUCT_ID",
                plan.to_uppercase(),
                currency.to_uppercase()
            ))?;
            if !crate::text::is_uuid(id) {
                return Err(Error("INVALID_BILLING_CONFIGURATION"));
            }
            products[plan][currency] = json!(id);
        }
    }
    let url = url::Url::parse(get("BETTER_AUTH_URL")?)
        .map_err(|_| Error("INVALID_BILLING_CONFIGURATION"))?;
    if !url.username().is_empty()
        || url.password().is_some_and(|s| !s.is_empty())
        || url.query().is_some_and(|s| !s.is_empty())
        || url.fragment().is_some_and(|s| !s.is_empty())
        || url.path() != "/"
        || !(url.scheme() == "https"
            || environment == "sandbox"
                && url.scheme() == "http"
                && ["localhost", "127.0.0.1", "[::1]"].contains(&url.host_str().unwrap_or("")))
    {
        return Err(Error("INVALID_BILLING_CONFIGURATION"));
    }
    Ok(Config::Enabled(Box::new(Enabled {
        enabled: true,
        environment: environment.clone(),
        access_token: access.into(),
        webhook_secret: webhook.into(),
        paid_products: products,
        app_url: url.origin().ascii_serialization(),
    })))
}

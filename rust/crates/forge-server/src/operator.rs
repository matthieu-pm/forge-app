//! Explicit operator targets. Native commands never read local dotenv files.
use std::collections::HashMap;
pub fn database_url(env: &HashMap<String, String>) -> Result<&str, &'static str> {
    let connection = env.get("DATABASE_URL").ok_or("INVALID_CONFIGURATION")?;
    let environment = env
        .get("FORGE_ENVIRONMENT")
        .ok_or("INVALID_CONFIGURATION")?;
    if !["development", "staging", "production"].contains(&environment.as_str())
        || environment == "development"
            && ["NODE_ENV", "VERCEL_ENV"]
                .iter()
                .any(|k| env.get(*k).is_some_and(|v| v == "production"))
    {
        return Err("INVALID_CONFIGURATION");
    }
    for key in ["AGENT_FAKE_RUNTIME_ENABLED", "EVE_EVAL_FIXTURE_MODE"] {
        let value = env.get(key).map(String::as_str).unwrap_or("");
        if !["", "true", "false"].contains(&value)
            || environment != "development" && value == "true"
        {
            return Err("INVALID_CONFIGURATION");
        }
    }
    let url = url::Url::parse(connection).map_err(|_| "INVALID_CONFIGURATION")?;
    if !["postgres", "postgresql"].contains(&url.scheme())
        || url.host_str().is_none()
        || url.path().len() <= 1
    {
        return Err("INVALID_CONFIGURATION");
    }
    forge_core::features::FeatureRollouts::parse(
        env.get("FORGE_FEATURE_ROLLOUTS").map(String::as_str),
    )
    .map_err(|_| "INVALID_CONFIGURATION")?;
    Ok(connection)
}

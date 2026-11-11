//! Persistent named workspaces. The caller journals the key before opening and
//! holds the conversation's worker lease. Every reconnect retires the previous
//! provider session before resuming its snapshot, so late cleanup targets only
//! an old session ID and cannot terminate the replacement.
use super::*;
use uuid::Uuid;
const MISSING: Error =
    Error("The saved sandbox workspace is unavailable. Its files cannot be silently replaced.");
const MAX_RETENTION: u64 = 30 * 24 * 60 * 60 * 1000;
pub struct WorkspaceOptions {
    pub key: Uuid,
    /// True only for a journaled creation intent whose successful provisioning
    /// has not yet been acknowledged. Never true for an established workspace.
    pub create_if_missing: bool,
    pub snapshot_retention_ms: u64,
}
impl Factory {
    pub async fn open_workspace(&self, options: WorkspaceOptions) -> Result<Arc<VercelSandbox>> {
        if options.key.is_nil()
            || !(60_000..=MAX_RETENTION).contains(&options.snapshot_retention_ms)
        {
            return Err(FAILED);
        }
        tokio::time::timeout(Duration::from_secs(90), self.open_workspace_inner(&options))
            .await
            .map_err(|_| Error("Sandbox workspace recovery timed out."))?
    }
    async fn open_workspace_inner(&self, options: &WorkspaceOptions) -> Result<Arc<VercelSandbox>> {
        let name = format!("forge-rust-workspace-{}", options.key.simple());
        let value = self.named(&name, false).await?;
        let value = match value {
            None if !options.create_if_missing => return Err(MISSING),
            None => {
                // A durable name is itself the recovery coordinate. Never launch
                // detached cleanup by name: another owner may already have
                // resumed it. Unknown create outcomes are bounded by provider
                // lifetime, then reconciled by the next leased open of this key.
                let response=self.0.request(Method::POST,"v2/sandboxes",Some(json!({
                    "projectId":self.0.options.project_id,"name":name,"persistent":true,
                    "ports":[],"timeout":self.0.options.lifetime_ms,"image":"vercel/eve:latest",
                    "networkPolicy":{"mode":"deny-all"},"env":{},
                    "tags":{"forge-native-workspace":"1"},
                    "snapshotExpiration":options.snapshot_retention_ms,
                    "keepLastSnapshots":{"count":1,"expiration":options.snapshot_retention_ms,"deleteEvicted":true}
                }))).await?;
                let value = json_response(response).await?;
                validate(&value, &name, options)?;
                value
            }
            Some(value) => {
                validate(&value, &name, options)?;
                let old = value["session"]["id"].as_str().ok_or(FAILED)?;
                // This is a replacement worker, not an automatic command retry.
                // Stop and wait even if lookup initially reports a live VM.
                if matches!(
                    value["session"]["status"].as_str(),
                    Some("running" | "pending")
                ) {
                    self.0.stop(old).await?;
                }
                self.wait_stopped(old).await?;
                let saved = self.named(&name, false).await?.ok_or(MISSING)?;
                validate(&saved, &name, options)?;
                if saved["session"]["id"] != old || saved["session"]["status"] != "stopped" {
                    return Err(FAILED);
                }
                let snapshot = saved["sandbox"]["currentSnapshotId"]
                    .as_str()
                    .filter(|id| identifier(id))
                    .ok_or(MISSING)?;
                let resumed = self.named(&name, true).await?.ok_or(MISSING)?;
                validate(&resumed, &name, options)?;
                if resumed["session"]["id"] == old
                    || resumed["session"]["sourceSnapshotId"] != snapshot
                {
                    // Do not adopt an unchanged VM or a different snapshot. If
                    // the response identifies a new owned session, revoke it.
                    if resumed["session"]["id"] != old
                        && let Ok(handle) = self.handle(&name, &resumed)
                    {
                        let _ = handle.shutdown().await;
                    }
                    return Err(FAILED);
                }
                resumed
            }
        };
        let sandbox = self.handle(&name, &value)?;
        self.activate(sandbox).await
    }
    async fn named(&self, name: &str, resume: bool) -> Result<Option<Value>> {
        let response = self
            .0
            .builder(Method::GET, &format!("v2/sandboxes/{name}"))
            .await?
            .query(&[
                ("projectId", self.0.options.project_id.as_str()),
                ("resume", if resume { "true" } else { "false" }),
            ])
            .send()
            .await
            .map_err(|_| FAILED)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Ok(Some(json_response(response).await?))
    }
    async fn wait_stopped(&self, session: &str) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(35), async {
            loop {
                let value = json_response(
                    self.0
                        .request(
                            Method::GET,
                            &format!("v2/sandboxes/sessions/{session}"),
                            None,
                        )
                        .await?,
                )
                .await?;
                if value["session"]["id"] != session {
                    return Err(FAILED);
                }
                match value["session"]["status"].as_str() {
                    Some("stopped") => return Ok(()),
                    Some("running" | "pending" | "stopping" | "snapshotting") => {
                        tokio::time::sleep(Duration::from_millis(100)).await
                    }
                    _ => return Err(MISSING),
                }
            }
        })
        .await
        .map_err(|_| Error("The previous sandbox session did not finish stopping."))?
    }
}
fn validate(value: &Value, name: &str, options: &WorkspaceOptions) -> Result<()> {
    let sandbox = &value["sandbox"];
    let session = &value["session"];
    if sandbox["name"] != name
        || sandbox["persistent"] != true
        || sandbox["tags"]["forge-native-workspace"] != "1"
        || sandbox["currentSessionId"] != session["id"]
        || session["id"].as_str().is_none_or(|id| !identifier(id))
        || sandbox["networkPolicy"]["mode"] != "deny-all"
        || session["networkPolicy"]["mode"] != "deny-all"
        || sandbox["snapshotExpiration"]
            .as_u64()
            .is_none_or(|n| n < 60_000 || n > options.snapshot_retention_ms)
        || sandbox["keepLastSnapshots"]["count"] != 1
        || sandbox["keepLastSnapshots"]["deleteEvicted"] != true
        || sandbox["keepLastSnapshots"]["expiration"]
            .as_u64()
            .is_none_or(|n| n < 60_000 || n > options.snapshot_retention_ms)
    {
        return Err(FAILED);
    }
    Ok(())
}
#[cfg(test)]
mod tests;

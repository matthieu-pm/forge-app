use super::*;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
impl Service {
    /// Receipts are keyed by both secret generation and caller event identity.
    /// Replays still require the current secret and external-source permission.
    pub async fn webhook(
        &self,
        loop_id: &str,
        token: &str,
        key: &str,
        payload: Value,
    ) -> Result<Option<Uuid>, StoreError> {
        let Ok(id) = id(loop_id) else {
            return Ok(None);
        };
        if !self.options.enabled {
            return Ok(None);
        }
        let key = forge_core::text::trim(key);
        if !(40..=100).contains(&token.len())
            || !token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || key.is_empty()
            || key.encode_utf16().count() > 200
        {
            return Err(StoreError::InvalidInput);
        }
        // Source JSON numbers are doubles; capture the same rounded value that
        // participates in the cross-language event hash.
        let payload =
            forge_core::json::parse(&forge_core::canonical::javascript_stringify(&payload))
                .map_err(|_| StoreError::InvalidInput)?;
        let mut tx = self.database.begin().await?;
        let row: Option<Definition> = sqlx::query_as(
            "SELECT * FROM team_loops WHERE id=$1 AND enabled AND deleted_at IS NULL FOR SHARE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        let actual = format!("{:x}", Sha256::digest(token.as_bytes()));
        let expected = row
            .as_ref()
            .and_then(|r| r.webhook_secret_hash.as_deref())
            .unwrap_or("0000000000000000000000000000000000000000000000000000000000000000");
        if !bool::from(actual.as_bytes().ct_eq(expected.as_bytes()))
            || row
                .as_ref()
                .is_none_or(|r| r.fields["trigger"]["kind"] != "webhook")
        {
            return Ok(None);
        }
        let row = row.as_ref().unwrap();
        if !security::settings(&mut tx, &row.workspace_id)
            .await?
            .external_loop_sources_enabled
        {
            return Ok(None);
        }
        let event_key = format!("webhook:{}:{key}", &expected[..16]);
        tx.prepare().await?;
        let run = enqueue(
            &mut tx,
            row,
            &event_key,
            json!({"kind":"webhook","payload":payload}),
        )
        .await?;
        tx.commit().await?;
        Ok(Some(run.id))
    }
}

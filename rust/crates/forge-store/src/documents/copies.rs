use super::*;
use std::collections::HashSet;
/// Used by generic product-state reads/writes; canonical IDs include tombstones.
pub async fn prune_team_copies(
    c: &mut PgConnection,
    a: &Actor,
    key: &str,
    value: Option<&str>,
    previous: Option<&str>,
) -> Result<Option<String>, StoreError> {
    let Some(raw) = key.strip_prefix("forge:team-home:v1:") else {
        return Ok(value.map(str::to_owned));
    };
    if raw.len() != 36
        || !raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
    {
        return Ok(value.map(str::to_owned));
    }
    let team: Uuid = raw.parse().map_err(|_| StoreError::InvalidInput)?;
    let ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM documents WHERE workspace_id=$1 AND team_id=$2")
            .bind(&a.workspace_id)
            .bind(team)
            .fetch_all(c)
            .await?;
    contract::retain_copies(
        value,
        previous,
        &ids.into_iter()
            .map(|v| v.to_string())
            .collect::<HashSet<_>>(),
    )
    .map_err(|_| StoreError::InvalidInput)
}
fn reviewed(resources: &[Value], id: &str, fields: &Value, kind: &str) -> Result<bool, StoreError> {
    let copies: Vec<_> = resources.iter().filter(|r| r["id"] == id).collect();
    if copies
        .iter()
        .any(|r| !contract::matches_legacy(r, fields, kind))
    {
        return Err(StoreError::DocumentConflict);
    }
    Ok(!copies.is_empty())
}
pub(super) async fn consume(
    c: &mut PgConnection,
    a: &Actor,
    source: &Value,
    document: &str,
    fields: &Value,
    legacy: bool,
) -> Result<(), StoreError> {
    match text(source, "kind") {
        "team" => {
            let key = format!("forge:team-home:v1:{}", text(source, "id"));
            let rows:Vec<(Uuid,Option<String>,i32)>=sqlx::query_as("SELECT id,encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id=$2 AND key=$3 FOR UPDATE").bind(&a.workspace_id).bind(format!("user:{}",a.user_id)).bind(key).fetch_all(&mut *c).await?;
            let mut found = false;
            for (id, encoded, revision) in rows {
                let Some(encoded) = encoded.filter(|s| !s.is_empty()) else {
                    continue;
                };
                let raw: String =
                    serde_json::from_str(&encoded).map_err(|_| StoreError::InvalidInput)?;
                let mut state: Value =
                    forge_core::json::parse(&raw).map_err(|_| StoreError::InvalidInput)?;
                let resources = state["resources"]
                    .as_array()
                    .ok_or(StoreError::DocumentConflict)?;
                if !reviewed(resources, document, fields, "team")? {
                    continue;
                }
                if !legacy {
                    return Err(StoreError::DocumentConflict);
                }
                found = true;
                state["resources"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|r| r["id"] != document);
                let encoded =
                    serde_json::to_string(&forge_core::canonical::javascript_stringify(&state))
                        .map_err(|_| StoreError::InvalidInput)?;
                sqlx::query("UPDATE product_state SET encoded_value=$1,revision=$2 WHERE id=$3")
                    .bind(encoded)
                    .bind(revision + 1)
                    .bind(id)
                    .execute(&mut *c)
                    .await?;
            }
            if legacy && !found {
                return Err(StoreError::DocumentConflict);
            }
        }
        "project" => {
            let id = id(source, "id")?;
            let raw: String = sqlx::query_scalar(
                "SELECT properties::text FROM projects WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            )
            .bind(&a.workspace_id)
            .bind(id)
            .fetch_one(&mut *c)
            .await?;
            let mut properties =
                forge_core::json::parse(&raw).map_err(|_| StoreError::InvalidInput)?;
            let found = if let Some(resources) = properties["resources"].as_array() {
                reviewed(resources, document, fields, "project")?
            } else {
                false
            };
            if !found {
                if legacy {
                    return Err(StoreError::DocumentConflict);
                }
                return Ok(());
            }
            if !legacy {
                return Err(StoreError::DocumentConflict);
            }
            properties["resources"]
                .as_array_mut()
                .unwrap()
                .retain(|r| r["id"] != document);
            sqlx::query("UPDATE projects SET properties=$1,revision=revision+1 WHERE id=$2")
                .bind(properties)
                .bind(id)
                .execute(c)
                .await?;
        }
        _ => {
            if legacy {
                return Err(StoreError::DocumentConflict);
            }
        }
    }
    Ok(())
}

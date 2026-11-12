use super::*;
const LABELS: &str = "forge:workspace-project-labels:v1";
fn key(a: &Actor, kind: &str) -> String {
    if kind == "statuses" {
        format!("forge:project-statuses:v1:{}", a.workspace_id)
    } else {
        LABELS.into()
    }
}
#[derive(FromRow)]
struct Stored {
    id: Uuid,
    encoded_value: Option<String>,
    revision: i32,
}
fn decode(encoded: &str) -> Result<Value, StoreError> {
    let raw: String = serde_json::from_str(encoded).map_err(|_| StoreError::InvalidInput)?;
    serde_json::from_str(&raw).map_err(|_| StoreError::InvalidInput)
}
pub(crate) async fn read(c: &mut PgConnection, a: &Actor) -> Result<Value, StoreError> {
    let mut result = json!({});
    for kind in ["statuses", "labels"] {
        let row:Option<Stored>=sqlx::query_as("SELECT id,encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id='workspace' AND key=$2").bind(&a.workspace_id).bind(key(a,kind)).fetch_optional(&mut *c).await?;
        let v = if let Some(encoded) = row.as_ref().and_then(|r| r.encoded_value.as_deref()) {
            decode(encoded)?
        } else if kind == "statuses" {
            contract::initial_statuses()
        } else {
            json!({"version":1,"labels":[],"groups":[],"inheritedCount":0})
        };
        result[kind] = parsed(if kind == "statuses" {
            contract::statuses(v)
        } else {
            contract::labels(v, false)
        })?;
        result[format!("{kind}Revision")] = json!(row.map_or(0, |r| r.revision));
    }
    Ok(result)
}
pub(super) async fn projected(c: &mut PgConnection, a: &Actor) -> Result<Value, StoreError> {
    let mut result = read(c, a).await?;
    let q = format!(
        "SELECT p.properties FROM projects p WHERE p.workspace_id=$1 AND {}",
        policy::readable_project(a, "p.id")
    );
    let rows: Vec<Value> = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .fetch_all(c)
        .await?;
    result["labels"]["catalogRevision"] = result["labelsRevision"].clone();
    result["labels"]["inheritedCount"] = json!(0);
    for kind in ["labels", "groups"] {
        for label in result["labels"][kind].as_array_mut().unwrap() {
            label["issues"] = json!(
                rows.iter()
                    .filter(|r| array(r, "labelIds").contains(&label["id"]))
                    .count()
            );
            label["lastApplied"] = Value::Null;
        }
    }
    Ok(result)
}
pub async fn read_catalog(db: &Database, a: &Actor) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let a = current_actor(&mut tx, a).await?;
    policy::scope(&a, ApiScope::ProjectsRead)?;
    let result = projected(&mut tx, &a).await?;
    tx.commit().await?;
    Ok(result)
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    revision: i32,
}
struct Save<'a> {
    input: &'a Value,
    next: Value,
    kind: &'a str,
}
#[async_trait]
impl CommandHandler for Save<'_> {
    type Output = Receipt;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&Receipt>,
    ) -> Result<(), StoreError> {
        if !matches!(a.authentication, Authentication::Session { .. })
            || a.scopes.is_some()
            || !policy::privileged(a)
        {
            return Err(StoreError::Forbidden);
        }
        fence(c, a).await
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Receipt>, StoreError> {
        let next = &self.next;
        let rows: Vec<Value> =
            sqlx::query_scalar("SELECT properties FROM projects WHERE workspace_id=$1")
                .bind(&a.workspace_id)
                .fetch_all(&mut *c)
                .await?;
        if self.kind == "statuses" {
            if array(next, "statuses").len() > 500 {
                return Err(invalid("Too many project statuses."));
            }
            let current = read(c, a).await?;
            for row in &rows {
                let id = text(row, "statusId");
                if id.is_empty() {
                    continue;
                }
                let old = array(&current["statuses"], "statuses")
                    .iter()
                    .find(|s| s["id"] == id);
                let status = array(next, "statuses").iter().find(|s| s["id"] == id);
                if status.is_none()
                    || old
                        .zip(status)
                        .is_some_and(|(old, next)| old["group"] != next["group"])
                {
                    return Err(invalid(
                        "A status in use cannot be deleted or moved to another workflow group.",
                    ));
                }
            }
        } else {
            for row in rows {
                for id in array(&row, "labelIds") {
                    if !array(next, "labels")
                        .iter()
                        .chain(array(next, "groups"))
                        .any(|l| l["id"] == *id)
                    {
                        return Err(invalid(
                            "A label in use cannot be deleted. Archive it instead.",
                        ));
                    }
                }
            }
        }
        let key = key(a, self.kind);
        sqlx::query("INSERT INTO product_state(workspace_id,owner_id,key,encoded_value) VALUES($1,'workspace',$2,NULL) ON CONFLICT DO NOTHING").bind(&a.workspace_id).bind(&key).execute(&mut *c).await?;
        let row:Stored=sqlx::query_as("SELECT id,encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id='workspace' AND key=$2 FOR UPDATE").bind(&a.workspace_id).bind(&key).fetch_one(&mut *c).await?;
        let value = &self.input["value"];
        if self.input["expectedRevision"] != row.revision {
            let prior = row
                .encoded_value
                .as_ref()
                .map(|s| serde_json::from_str::<Value>(s))
                .transpose()
                .map_err(|_| StoreError::InvalidInput)?
                .unwrap_or(Value::Null);
            if prior == *value {
                return Ok(CommandResult {
                    value: Receipt {
                        revision: row.revision,
                    },
                    resource_type: "productState".into(),
                    resource_id: row.id.to_string(),
                    events: vec![],
                });
            }
            return Err(invalid(
                "This data changed in another session. Your pending changes are preserved in this session; reload the latest version before retrying.",
            ));
        }
        let old_version = if let Some(encoded) = row.encoded_value.as_deref() {
            decode(encoded)?["version"].as_i64().unwrap_or(0)
        } else {
            0
        };
        if if self.kind == "labels" {
            next["catalogRevision"] != row.revision
        } else {
            next["version"] != old_version + 1
        } {
            return Err(invalid(
                "This data changed in another session. Your catalog draft is preserved; load the latest version and review it.",
            ));
        }
        sqlx::query("UPDATE product_state SET encoded_value=$1,revision=revision+1 WHERE id=$2")
            .bind(value.to_string())
            .bind(row.id)
            .execute(c)
            .await?;
        Ok(CommandResult {
            value: Receipt {
                revision: row.revision + 1,
            },
            resource_type: "productState".into(),
            resource_id: row.id.to_string(),
            events: vec![event("project.catalog.updated", json!({"key":key}))],
        })
    }
}
/// `value` is the serialized editor snapshot, preserving reference receipt hashes.
pub async fn save_catalog(db: &Database, a: &Actor, input: Value) -> Result<Value, StoreError> {
    let input = contract::catalog_command(input).map_err(|_| StoreError::InvalidInput)?;
    let kind = text(&input, "kind");
    let raw = input["value"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            invalid("Shared project catalogs cannot be cleared. Edit their entries instead.")
        })?;
    let value: Value = serde_json::from_str(raw).map_err(|_| StoreError::InvalidInput)?;
    let next = parsed(if kind == "statuses" {
        contract::statuses(value)
    } else {
        contract::labels(value, true)
    })?;
    let payload = json!({"workspaceId":a.workspace_id,"key":key(a,kind),"value":input["value"],"expectedRevision":input["expectedRevision"]});
    let result = commands::execute(
        db,
        a,
        Command {
            key: text(&input, "commandKey"),
            operation: "productState.save@1",
            input: &payload,
            status: 200,
        },
        &Save {
            input: &input,
            next,
            kind,
        },
    )
    .await?;
    Ok(json!({"value":result.value,"replayed":result.replayed}))
}

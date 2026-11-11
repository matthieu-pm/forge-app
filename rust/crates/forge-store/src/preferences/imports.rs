//! Explicit owner-scoped review checkpoints; source payloads never enter receipts.
use super::*;
use forge_core::preferences::imports as contract;
use uuid::Uuid;
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn authorize(a: &Actor, identity: &Value, options: PreferenceOptions) -> Result<(), StoreError> {
    session(a, identity["sessionId"].as_str())?;
    if identity["userId"] != a.user_id || identity["workspaceId"] != a.workspace_id {
        return Err(StoreError::Forbidden);
    }
    sync(options)?;
    if !options.import_enabled {
        return Err(StoreError::Forbidden);
    }
    Ok(())
}
async fn current_source(c: &mut PgConnection, a: &Actor, source: &Value) -> Result<(), StoreError> {
    if source["location"] != "saved" {
        return Ok(());
    }
    let source = source.get("recovery").unwrap_or(source);
    let encoded:Option<Option<String>>=sqlx::query_scalar("SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND owner_id=$2 AND owner_user_id=$3 AND key=$4 FOR SHARE").bind(&a.workspace_id).bind(format!("user:{}",a.user_id)).bind(&a.user_id).bind(text(source,"key")).fetch_optional(c).await?;
    let raw = encoded
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    if raw.as_ref() != Some(&source["raw"]) {
        return Err(StoreError::Planning(
            "The saved source changed. Its preserved copy remains available. Preview again before importing.",
        ));
    }
    Ok(())
}
async fn manifest(
    c: &mut PgConnection,
    a: &Actor,
    id: Uuid,
    lock: bool,
) -> Result<Value, StoreError> {
    let q = format!(
        "SELECT i.manifest,c.source,c.baseline FROM personal_preference_imports i JOIN personal_preference_import_content c ON c.import_id=i.id WHERE i.id=$1 AND i.user_id=$2 AND i.workspace_id=$3 {}",
        if lock { "FOR UPDATE OF i,c" } else { "" }
    );
    let (checkpoint, source, baseline): (Value, Value, Value) = sqlx::query_as(&q)
        .bind(id)
        .bind(&a.user_id)
        .bind(&a.workspace_id)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    let v =
        contract::hydrate(checkpoint, source, baseline).map_err(|_| StoreError::InvalidInput)?;
    if contract::fingerprint(&v["plan"]["source"]) != v["plan"]["fingerprint"] {
        return Err(StoreError::Planning(
            "The saved source fingerprint changed. Download the original source and preview again.",
        ));
    }
    Ok(v)
}
pub async fn load(
    db: &Database,
    a: &Actor,
    identity: Value,
    options: PreferenceOptions,
) -> Result<Value, StoreError> {
    let identity = contract::identity(identity).map_err(|_| StoreError::InvalidInput)?;
    session(a, identity["sessionId"].as_str())?;
    if identity["userId"] != a.user_id || identity["workspaceId"] != a.workspace_id {
        return Err(StoreError::Forbidden);
    }
    if !options.enabled || !options.import_enabled {
        return Ok(json!({"status":"disabled"}));
    }
    authorize(a, &identity, options)?;
    let snapshot = read(db, a, "account", options).await?;
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    let account: Option<(String, String)> =
        sqlx::query_as("SELECT name,email FROM \"user\" WHERE id=$1")
            .bind(&a.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let rows:Vec<(Value,Value,Value)>=sqlx::query_as("SELECT i.manifest,c.source,c.baseline FROM personal_preference_imports i JOIN personal_preference_import_content c ON c.import_id=i.id WHERE i.user_id=$1 AND i.workspace_id=$2 ORDER BY i.created_at DESC").bind(&a.user_id).bind(&a.workspace_id).fetch_all(&mut *tx).await?;
    let manifests = rows
        .into_iter()
        .map(|(p, s, b)| contract::hydrate(p, s, b).map_err(|_| StoreError::InvalidInput))
        .collect::<Result<Vec<_>, _>>()?;
    tx.commit().await?;
    Ok(
        json!({"status":"ready","snapshot":snapshot,"accountLabel":account.map_or_else(||a.user_id.clone(),|(name,email)|format!("{name} ({email})")),"manifests":manifests}),
    )
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    #[serde(deserialize_with = "saved_id")]
    id: String,
}
fn saved_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if forge_core::text::is_uuid(&value) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("UUID"))
    }
}
struct Prepare<'a> {
    plan: &'a Value,
    options: PreferenceOptions,
}
#[async_trait]
impl CommandHandler for Prepare<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&Saved>,
    ) -> Result<(), StoreError> {
        authorize(a, &self.plan["identity"], self.options)?;
        current_source(c, a, &self.plan["source"]).await
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        let fields: serde_json::Map<String, Value> = self.plan["choices"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    json!(if v == "import" { "pending" } else { "kept" }),
                )
            })
            .collect();
        let (checkpoint, source, baseline) =
            contract::split(&json!({"plan":self.plan,"fields":fields}));
        let id = text(self.plan, "id");
        let uuid = id.parse::<Uuid>().map_err(|_| StoreError::InvalidInput)?;
        sqlx::query("INSERT INTO personal_preference_imports(id,user_id,workspace_id,manifest) VALUES($1,$2,$3,$4)").bind(uuid).bind(&a.user_id).bind(&a.workspace_id).bind(checkpoint).execute(&mut *c).await?;
        sqlx::query("INSERT INTO personal_preference_import_content(import_id,source,baseline) VALUES($1,$2,$3)").bind(uuid).bind(source).bind(baseline).execute(c).await?;
        Ok(CommandResult {
            value: Saved { id: id.into() },
            resource_type: "personalPreferenceImport".into(),
            resource_id: id.into(),
            events: vec![],
        })
    }
}
async fn reread(db: &Database, a: &Actor, id: Uuid) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    let v = manifest(&mut tx, &a, id, false).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn prepare(
    db: &Database,
    a: &Actor,
    input: Value,
    options: PreferenceOptions,
) -> Result<Value, StoreError> {
    let reviewed = contract::plan(input).map_err(|_| StoreError::InvalidInput)?;
    let plan = contract::validate(reviewed.clone()).map_err(|_| StoreError::InvalidInput)?;
    authorize(a, &plan["identity"], options)?;
    if contract::fingerprint(&plan["source"]) != plan["fingerprint"] {
        return Err(StoreError::Planning(
            "The source fingerprint changed. Preview again.",
        ));
    }
    let mut durable = reviewed;
    durable.as_object_mut().unwrap().remove("identity");
    commands::execute(
        db,
        a,
        Command {
            key: text(&plan, "id"),
            operation: "personalPreferenceImport.prepare@1",
            input: &durable,
            status: 200,
        },
        &Prepare {
            plan: &plan,
            options,
        },
    )
    .await?;
    reread(
        db,
        a,
        text(&plan, "id")
            .parse()
            .map_err(|_| StoreError::InvalidInput)?,
    )
    .await
}
struct Apply<'a> {
    input: &'a Value,
    options: PreferenceOptions,
    id: Uuid,
}
#[async_trait]
impl CommandHandler for Apply<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&Saved>,
    ) -> Result<(), StoreError> {
        authorize(a, &self.input["identity"], self.options)?;
        let m = manifest(c, a, self.id, false).await?;
        current_source(c, a, &m["plan"]["source"]).await?;
        if m["plan"]["fingerprint"] != self.input["fingerprint"]
            || m["fields"].get(text(self.input, "path")).is_none()
        {
            return Err(StoreError::Forbidden);
        }
        Ok(())
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        let mut m = manifest(c, a, self.id, true).await?;
        let path = text(self.input, "path");
        if m["fields"][path] == "pending" {
            let inspected = contract::inspect(&m["plan"]["source"], &a.user_id);
            let value = inspected["fields"].get(path).ok_or(StoreError::Forbidden)?;
            let mut row = row(c, a, "account", true)
                .await?
                .ok_or(StoreError::InvalidInput)?;
            if row.version != 1 {
                return Err(StoreError::Planning(
                    "Preferences require a newer version of Forge.",
                ));
            }
            let baseline = &m["plan"]["snapshot"];
            let expected = field_version(baseline["fieldVersions"].get(path));
            let matches = field_version(row.field_versions.get(path)) == expected
                && row
                    .values
                    .get(path)
                    .map(forge_core::canonical::javascript_stringify)
                    == baseline["values"]
                        .get(path)
                        .map(forge_core::canonical::javascript_stringify);
            if !matches {
                m["fields"][path] = json!("conflict")
            } else {
                row.revision = row
                    .revision
                    .checked_add(1)
                    .ok_or(StoreError::InvalidInput)?;
                row.values[path] = super::contract::field("account", path, value.clone(), false)
                    .map_err(|_| StoreError::InvalidInput)?;
                row.field_versions[path] = json!(row.revision);
                write(c, a, "account", &row).await?;
                m["fields"][path] = json!("saved")
            }
            sqlx::query("UPDATE personal_preference_imports SET manifest=$1 WHERE id=$2")
                .bind(contract::split(&m).0)
                .bind(self.id)
                .execute(c)
                .await?;
        }
        Ok(CommandResult {
            value: Saved {
                id: text(self.input, "id").into(),
            },
            resource_type: "personalPreferenceImport".into(),
            resource_id: text(self.input, "id").into(),
            events: vec![],
        })
    }
}
pub async fn apply(
    db: &Database,
    a: &Actor,
    input: Value,
    options: PreferenceOptions,
) -> Result<Value, StoreError> {
    let input = contract::request(input).map_err(|_| StoreError::InvalidInput)?;
    authorize(a, &input["identity"], options)?;
    let id = text(&input, "id")
        .parse()
        .map_err(|_| StoreError::InvalidInput)?;
    let durable = json!({"id":input["id"],"path":input["path"],"fingerprint":input["fingerprint"]});
    commands::execute(
        db,
        a,
        Command {
            key: &format!("{}:{}", text(&input, "id"), text(&input, "path")),
            operation: "personalPreferenceImport.apply@1",
            input: &durable,
            status: 200,
        },
        &Apply {
            input: &input,
            options,
            id,
        },
    )
    .await?;
    reread(db, a, id).await
}

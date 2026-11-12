//! Revisioned shared documents, current-source authority and exact legacy imports.
use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult, OutboxEvent},
    projects, resource_policy as policy,
    workspaces::lock_workspace,
};
use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    documents as contract,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;
mod copies;
pub use copies::prune_team_copies;
#[derive(Clone, Copy)]
pub struct DocumentOptions {
    pub enabled: bool,
    pub team_resources: bool,
}
impl DocumentOptions {
    pub fn from_env() -> Self {
        let mut env = json!({});
        for key in [
            "NODE_ENV",
            "VERCEL_ENV",
            "FORGE_ENVIRONMENT",
            "FORGE_SERVICE_ENVIRONMENT",
            "FORGE_SHARED_DOCUMENTS_ENABLED",
            "FORGE_TEAM_RESOURCES_ENABLED",
        ] {
            if let Ok(v) = std::env::var(key) {
                env[key] = json!(v);
            }
        }
        Self {
            enabled: contract::feature_enabled(&env, "FORGE_SHARED_DOCUMENTS_ENABLED"),
            team_resources: contract::feature_enabled(&env, "FORGE_TEAM_RESOURCES_ENABLED"),
        }
    }
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn id(v: &Value, k: &str) -> Result<Uuid, StoreError> {
    text(v, k).parse().map_err(|_| StoreError::InvalidInput)
}
fn parse(v: Result<Value, contract::DocumentError>) -> Result<Value, StoreError> {
    v.map_err(|_| {
        StoreError::Planning(
            "Unsupported or unsafe document content. Your draft has been preserved.",
        )
    })
}
fn session(a: &Actor, options: DocumentOptions) -> Result<(), StoreError> {
    if options.enabled
        && matches!(a.authentication, Authentication::Session { .. })
        && a.scopes.is_none()
    {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
async fn fence(c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}
async fn source_access(
    c: &mut PgConnection,
    a: &Actor,
    source: &Value,
    options: DocumentOptions,
) -> Result<(), StoreError> {
    session(a, options)?;
    let kind = text(source, "kind");
    if kind == "workspace" {
        return Ok(());
    }
    sqlx::query("SELECT id FROM team_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE")
        .bind(&a.workspace_id)
        .bind(&a.user_id)
        .fetch_all(&mut *c)
        .await?;
    let id = id(source, "id")?;
    match kind {
        "team" => policy::team(c, a, id).await?,
        "project" => projects::lock_project(c, a, id).await?,
        "issue" => {
            let issue = policy::issue(c, a, id, false).await?;
            policy::team(c, a, issue.team_id).await?;
            sqlx::query("SELECT id FROM issues WHERE id=$1 FOR SHARE")
                .bind(id)
                .fetch_one(c)
                .await?;
        }
        _ => return Err(StoreError::InvalidInput),
    }
    Ok(())
}
#[derive(FromRow)]
struct Row {
    id: Uuid,
    title: String,
    #[sqlx(rename = "body_json")]
    body: String,
    icon: Value,
    section_id: Option<String>,
    content: String,
    revision: i32,
    owner_id: Option<String>,
    updated_by_id: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
    shared_with_workspace: bool,
    team_id: Option<Uuid>,
    project_id: Option<Uuid>,
    issue_id: Option<Uuid>,
}
impl Row {
    fn source(&self) -> Value {
        if let Some(id) = self.team_id {
            json!({"kind":"team","id":id})
        } else if let Some(id) = self.project_id {
            json!({"kind":"project","id":id})
        } else if let Some(id) = self.issue_id {
            json!({"kind":"issue","id":id})
        } else {
            json!({"kind":"workspace"})
        }
    }
    fn fields(&self) -> Result<Value, StoreError> {
        Ok(
            json!({"title":self.title,"body":forge_core::json::parse(&self.body).map_err(|_|StoreError::InvalidInput)?,"icon":self.icon,"sectionId":self.section_id}),
        )
    }
}
async fn accessible(
    c: &mut PgConnection,
    a: &Actor,
    id: Uuid,
    deleted: bool,
    options: DocumentOptions,
) -> Result<Row, StoreError> {
    session(a, options)?;
    let q = format!(
        "SELECT d.*,d.body::text AS body_json FROM documents d WHERE d.workspace_id=$1 AND d.id=$4 AND {} FOR SHARE OF d",
        if deleted {
            "$2::boolean IS NOT NULL AND $3::text IS NOT NULL".into()
        } else {
            policy::readable_document(a, "d.id")
        }
    );
    let row: Row = sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(id)
        .fetch_optional(&mut *c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    if !row.shared_with_workspace {
        source_access(c, a, &row.source(), options).await?;
    }
    Ok(row)
}
async fn person(c: &mut PgConnection, id: Option<&str>) -> Result<Value, StoreError> {
    if let Some(id) = id {
        Ok(sqlx::query_scalar(
            "SELECT jsonb_build_object('id',id,'name',name) FROM \"user\" WHERE id=$1",
        )
        .bind(id)
        .fetch_optional(c)
        .await?
        .unwrap_or(Value::Null))
    } else {
        Ok(Value::Null)
    }
}
fn safe_fields(value: &Value) -> Value {
    let body = contract::body(value["body"].clone());
    let mut result = json!({"title":value["title"],"body":body.as_ref().unwrap_or(&value["body"]),"icon":contract::document_icon(value["icon"].clone()).unwrap_or_else(|_|contract::default_icon()),"sectionId":value["sectionId"]});
    if body.is_err() {
        result["unsafeBody"] = json!(true);
    }
    result
}
async fn project(c: &mut PgConnection, a: &Actor, row: &Row) -> Result<Value, StoreError> {
    let mut value = safe_fields(&row.fields()?);
    value.as_object_mut().unwrap().extend(json!({"id":row.id,"revision":row.revision,"content":row.content,"createdAt":row.created_at.to_rfc3339_opts(SecondsFormat::Millis,true),"updatedAt":row.updated_at.to_rfc3339_opts(SecondsFormat::Millis,true),"owner":person(c,row.owner_id.as_deref()).await?,"updatedBy":person(c,row.updated_by_id.as_deref()).await?,"canDelete":row.owner_id.as_deref()==Some(&a.user_id)||policy::privileged(a),"canShare":policy::privileged(a),"sharedWithWorkspace":row.shared_with_workspace}).as_object().unwrap().clone());
    Ok(value)
}
pub async fn read(
    db: &Database,
    a: &Actor,
    source: Option<Value>,
    selected: Option<Uuid>,
    options: DocumentOptions,
) -> Result<Value, StoreError> {
    session(a, options)?;
    let source = source
        .map(contract::source)
        .transpose()
        .map_err(|_| StoreError::InvalidInput)?;
    let mut tx = db.begin().await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    fence(&mut tx, &a).await?;
    let rows = if let Some(id) = selected {
        vec![accessible(&mut tx, &a, id, false, options).await?]
    } else {
        let source = source.ok_or(StoreError::Forbidden)?;
        source_access(&mut tx, &a, &source, options).await?;
        let (condition, source_id) = match text(&source, "kind") {
            "workspace" => ("$4::uuid IS NULL", None),
            "team" => ("d.team_id=$4", Some(id(&source, "id")?)),
            "project" => ("d.project_id=$4", Some(id(&source, "id")?)),
            _ => ("d.issue_id=$4", Some(id(&source, "id")?)),
        };
        let q = format!(
            "SELECT d.*,d.body::text AS body_json FROM documents d WHERE {} AND {condition} ORDER BY d.updated_at DESC,d.id",
            policy::readable_document(&a, "d.id")
        );
        sqlx::query_as(&q)
            .bind(&a.workspace_id)
            .bind(policy::privileged(&a))
            .bind(&a.user_id)
            .bind(source_id)
            .fetch_all(&mut *tx)
            .await?
    };
    let mut result = vec![];
    for row in rows {
        result.push(project(&mut tx, &a, &row).await?);
    }
    tx.commit().await?;
    Ok(json!(result))
}
#[derive(FromRow)]
struct Revision {
    revision: i32,
    snapshot: String,
    author_id: Option<String>,
    created_at: DateTime<Utc>,
}
pub async fn history(
    db: &Database,
    a: &Actor,
    id: Uuid,
    before: Option<i64>,
    options: DocumentOptions,
) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    fence(&mut tx, &a).await?;
    accessible(&mut tx, &a, id, false, options).await?;
    let rows:Vec<Revision>=sqlx::query_as("SELECT revision,snapshot::text AS snapshot,author_id,created_at FROM document_revisions WHERE workspace_id=$1 AND document_id=$2 AND ($3::bigint IS NULL OR revision::bigint<$3) ORDER BY revision DESC LIMIT 30").bind(&a.workspace_id).bind(id).bind(before.filter(|v|*v!=0)).fetch_all(&mut *tx).await?;
    let mut result = vec![];
    for row in rows {
        let mut value = safe_fields(
            &forge_core::json::parse(&row.snapshot).map_err(|_| StoreError::InvalidInput)?,
        );
        value["revision"] = json!(row.revision);
        value["createdAt"] = json!(row.created_at.to_rfc3339_opts(SecondsFormat::Millis, true));
        value["author"] = person(&mut tx, row.author_id.as_deref()).await?;
        result.push(value);
    }
    tx.commit().await?;
    Ok(json!(result))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    #[serde(deserialize_with = "saved_id")]
    id: String,
    #[serde(deserialize_with = "positive")]
    revision: i32,
}
fn saved_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let s = String::deserialize(d)?;
    if forge_core::text::is_uuid(&s) {
        Ok(s)
    } else {
        Err(serde::de::Error::custom("UUID"))
    }
}
fn positive<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i32, D::Error> {
    let n = i32::deserialize(d)?;
    if n > 0 {
        Ok(n)
    } else {
        Err(serde::de::Error::custom("positive revision"))
    }
}
struct Write<'a> {
    input: &'a Value,
    options: DocumentOptions,
}
#[async_trait]
impl CommandHandler for Write<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        saved: Option<&Saved>,
    ) -> Result<(), StoreError> {
        fence(c, a).await?;
        let action = text(self.input, "action");
        if action == "create" {
            source_access(c, a, &self.input["source"], self.options).await?;
            if let Some(saved) = saved {
                accessible(
                    c,
                    a,
                    saved.id.parse().map_err(|_| StoreError::InvalidInput)?,
                    true,
                    self.options,
                )
                .await?;
            }
        } else {
            let row = accessible(
                c,
                a,
                id(self.input, "id")?,
                action == "delete",
                self.options,
            )
            .await?;
            if (action == "delete"
                && row.owner_id.as_deref() != Some(&a.user_id)
                && !policy::privileged(a))
                || (action == "share" && !policy::privileged(a))
            {
                return Err(StoreError::Forbidden);
            }
        }
        Ok(())
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        let input = self.input;
        let id = id(input, "id")?;
        let action = text(input, "action");
        let old:Option<Row>=sqlx::query_as("SELECT *,body::text AS body_json FROM documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE").bind(&a.workspace_id).bind(id).fetch_optional(&mut *c).await?;
        if if action == "create" {
            old.is_some()
        } else {
            old.as_ref()
                .is_none_or(|r| r.deleted_at.is_some() || input["expectedRevision"] != r.revision)
        } {
            return Err(StoreError::DocumentConflict);
        }
        let now = Utc::now();
        let revision = old.as_ref().map_or(Ok(1), |r| {
            r.revision.checked_add(1).ok_or(StoreError::InvalidInput)
        })?;
        let mut fields = if action == "restore" {
            let saved:String=sqlx::query_scalar("SELECT snapshot::text FROM document_revisions WHERE workspace_id=$1 AND document_id=$2 AND revision::bigint=$3").bind(&a.workspace_id).bind(id).bind(input["revision"].as_i64().unwrap()).fetch_optional(&mut *c).await?.ok_or(StoreError::Forbidden)?;
            parse(contract::fields(
                forge_core::json::parse(&saved).map_err(|_| StoreError::InvalidInput)?,
            ))?
        } else if ["create", "save"].contains(&action) {
            input["fields"].clone()
        } else {
            old.as_ref().unwrap().fields()?
        };
        let team = if action == "create" && input["source"]["kind"] == "team" {
            Some(super::documents::id(&input["source"], "id")?)
        } else {
            old.as_ref().and_then(|r| r.team_id)
        };
        if let Some(team) = team
            && self.options.team_resources
        {
            let previous = old.as_ref().and_then(|r| r.section_id.as_deref());
            let next = fields["sectionId"].as_str();
            if action != "create" && next != previous {
                source_access(c, a, &json!({"kind":"team","id":team}), self.options).await?;
            }
            if let Some(section) = next
                && (action == "create" || next != previous)
            {
                let board:Option<Value>=sqlx::query_scalar("SELECT fields FROM team_resource_boards WHERE workspace_id=$1 AND team_id=$2 FOR SHARE").bind(&a.workspace_id).bind(team).fetch_optional(&mut *c).await?;
                if !board.as_ref().is_some_and(|v| {
                    forge_core::projects::array(v, "sections")
                        .iter()
                        .any(|s| s["id"] == section)
                }) {
                    if action == "restore" {
                        fields["sectionId"] = Value::Null;
                    } else {
                        return Err(StoreError::Planning(
                            "This resource section is no longer available. Choose a current section or Team resources.",
                        ));
                    }
                }
            }
        }
        let content = if ["delete", "share"].contains(&action) {
            old.as_ref().unwrap().content.clone()
        } else {
            contract::plain_text(&fields["body"])
        };
        if action == "create" {
            let source = &input["source"];
            let source_id = source
                .get("id")
                .map(|_| super::documents::id(source, "id"))
                .transpose()?;
            sqlx::query("INSERT INTO documents(id,workspace_id,title,body,icon,section_id,content,revision,owner_id,updated_by_id,created_at,updated_at,team_id,project_id,issue_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$10,$11,$12,$13)").bind(id).bind(&a.workspace_id).bind(text(&fields,"title")).bind(&fields["body"]).bind(&fields["icon"]).bind(fields["sectionId"].as_str()).bind(content).bind(revision).bind(&a.user_id).bind(now).bind(if source["kind"]=="team"{source_id}else{None}).bind(if source["kind"]=="project"{source_id}else{None}).bind(if source["kind"]=="issue"{source_id}else{None}).execute(&mut *c).await?;
            copies::consume(
                c,
                a,
                source,
                text(input, "id"),
                &input["fields"],
                input["legacyImport"] == true,
            )
            .await?;
        } else {
            sqlx::query("UPDATE documents SET title=$1,body=$2,icon=$3,section_id=$4,content=$5,revision=$6,updated_at=$7,updated_by_id=$8,deleted_at=CASE WHEN $9 THEN $7 ELSE deleted_at END,shared_with_workspace=COALESCE($10,shared_with_workspace) WHERE id=$11").bind(text(&fields,"title")).bind(&fields["body"]).bind(&fields["icon"]).bind(fields["sectionId"].as_str()).bind(content).bind(revision).bind(now).bind(&a.user_id).bind(action=="delete").bind(if action=="share"{input["shared"].as_bool()}else{None}).bind(id).execute(&mut *c).await?;
        }
        sqlx::query("INSERT INTO document_revisions(workspace_id,document_id,revision,snapshot,author_id,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&a.workspace_id).bind(id).bind(revision).bind(fields).bind(&a.user_id).bind(now).execute(c).await?;
        Ok(CommandResult {
            value: Saved {
                id: text(input, "id").into(),
                revision,
            },
            resource_type: "document".into(),
            resource_id: text(input, "id").into(),
            events: vec![OutboxEvent {
                topic: format!("document.{action}"),
                payload: json!({"documentId":input["id"],"revision":revision})
                    .as_object()
                    .unwrap()
                    .clone(),
            }],
        })
    }
}
pub async fn command(
    db: &Database,
    a: &Actor,
    key: &str,
    input: Value,
    options: DocumentOptions,
) -> Result<Value, StoreError> {
    session(a, options)?;
    if !forge_core::text::is_uuid(key) {
        return Err(StoreError::InvalidInput);
    }
    let input = contract::command(input).map_err(|_| StoreError::InvalidInput)?;
    match commands::execute(
        db,
        a,
        Command {
            key,
            operation: "documents.write@1",
            input: &input,
            status: 200,
        },
        &Write {
            input: &input,
            options,
        },
    )
    .await
    {
        Ok(result) => {
            Ok(json!({"status":"saved","id":result.value.id,"revision":result.value.revision}))
        }
        Err(StoreError::DocumentConflict) => {
            let current = read(db, a, None, Some(id(&input, "id")?), options)
                .await
                .ok()
                .and_then(|v| v.as_array().and_then(|a| a.first().cloned()))
                .unwrap_or(Value::Null);
            Ok(json!({"status":"conflict","current":current}))
        }
        Err(error) => Err(error),
    }
}
pub async fn share(
    db: &Database,
    a: &Actor,
    id: Uuid,
    shared: bool,
    options: DocumentOptions,
) -> Result<Value, StoreError> {
    let rows = read(db, a, None, Some(id), options).await?;
    let result = command(
        db,
        a,
        &Uuid::new_v4().to_string(),
        json!({"action":"share","id":id,"expectedRevision":rows[0]["revision"],"shared":shared}),
        options,
    )
    .await?;
    if result["status"] != "saved" {
        return Err(StoreError::Planning(
            "The document changed. Review the latest revision before changing sharing.",
        ));
    }
    Ok(json!({"id":id}))
}

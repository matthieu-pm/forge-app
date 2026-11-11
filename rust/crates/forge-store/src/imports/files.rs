use super::*;
use crate::commands::{self, Command, CommandHandler, CommandResult, OutboxEvent};
use async_trait::async_trait;
use execution::{Saved, graph, reread};
fn result(m: &Value, e: &Value, events: Vec<OutboxEvent>) -> CommandResult<Saved> {
    let mut r = execution::result(m, events);
    r.resource_type = "issue".into();
    r.resource_id = text(e, "canonicalId").into();
    r
}
struct Finalize<'a> {
    input: &'a Value,
    options: ImportOptions,
}
#[async_trait]
impl CommandHandler for Finalize<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&Saved>,
    ) -> Result<(), StoreError> {
        fence(c, a).await?;
        let m = load(c, a, id(self.input, "id")?, false, self.options).await?;
        let entry = array(&m, "entries")
            .iter()
            .find(|e| e["id"] == self.input["entryId"])
            .ok_or(StoreError::Forbidden)?;
        if target(c, a, entry, text(entry, "canonicalId"), false, self.options)
            .await?
            .is_none()
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
        graph(c, a).await?;
        let mut m = load(c, a, id(self.input, "id")?, true, self.options).await?;
        let position = array(&m, "entries")
            .iter()
            .position(|e| e["id"] == self.input["entryId"])
            .ok_or(StoreError::Planning("The imported issue is unavailable."))?;
        let mut entry = m["entries"][position].clone();
        if entry["state"] != "saved"
            || entry["kind"] != "issue"
            || text(&entry, "canonicalId").is_empty()
        {
            return Err(StoreError::Planning("The imported issue is unavailable."));
        }
        let index = self.input["index"]
            .as_u64()
            .ok_or(StoreError::InvalidInput)? as usize;
        let source = array(&entry, "files")
            .get(index)
            .cloned()
            .ok_or(StoreError::Planning(
                "The import file source is unavailable.",
            ))?;
        if text(&source, "fileId").is_empty() && !entry["draft"].is_object() {
            return Err(StoreError::Planning(
                "The import file source is unavailable.",
            ));
        }
        if !text(&source, "fileId").is_empty() {
            return Ok(result(&m, &entry, vec![]));
        }
        if m["revision"] != self.input["revision"] {
            return Err(StoreError::Planning(
                "Import progress changed. Reload and resume.",
            ));
        }
        let issue = id(&entry, "canonicalId")?;
        policy::issue(c, a, issue, true).await?;
        let row = targets::raw(c, a, "issue", issue, false)
            .await?
            .ok_or(StoreError::Forbidden)?;
        let file_id = id(self.input, "fileId")?;
        let file: Option<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(f) FROM resource_files f WHERE workspace_id=$1 AND id=$2",
        )
        .bind(&a.workspace_id)
        .bind(file_id)
        .fetch_optional(&mut *c)
        .await?;
        if file.as_ref().is_none_or(|f| {
            f["checksum"] != source["checksum"]
                || f["size_bytes"] != source["sizeBytes"]
                || f["name"] != source["name"]
        }) {
            return Err(StoreError::Planning(
                "The uploaded file does not match the verified legacy bytes.",
            ));
        }
        let mut attachments = array(&row["properties"], "attachments").to_vec();
        let mut width = source.get("width").cloned();
        let mut anchor = source.get("legacyId").cloned();
        if entry["replaceLegacyFiles"] == true {
            let existing = attachments.iter().position(|f| {
                text(f, "fileId").is_empty()
                    && contract::validated_files(std::slice::from_ref(f)).is_ok_and(|files| {
                        ["name", "checksum", "sizeBytes"]
                            .iter()
                            .all(|k| files[0][*k] == source[*k])
                    })
            });
            let Some(index) = existing else {
                entry["state"] = json!("pending");
                review::reconcile(c, a, &m, &mut entry, self.options).await?;
                entry["message"] = json!(
                    "The existing legacy file changed or was removed. Review the shared issue before retrying."
                );
                m["entries"][position] = entry.clone();
                save(c, &mut m).await?;
                return Ok(result(&m, &entry, vec![]));
            };
            let old = attachments.remove(index);
            width = old.get("width").cloned();
            anchor = Some(json!(contract::attachment_anchor(&old)));
        }
        let mut bound =
            crate::issues::bind_import_files(c, a, issue, &[file_id], json!(attachments)).await?;
        for f in bound.as_array_mut().ok_or(StoreError::InvalidInput)? {
            if f["fileId"] == self.input["fileId"] {
                if let Some(anchor) = anchor.as_ref().filter(|v| !v.is_null()) {
                    f["id"] = anchor.clone();
                }
                if let Some(width) = width.as_ref().filter(|v| forge_core::comments::truthy(v)) {
                    f["width"] = width.clone();
                }
            }
        }
        let mut properties = row["properties"].clone();
        properties["attachments"] = bound;
        sqlx::query("UPDATE issues SET properties=$1 WHERE id=$2")
            .bind(properties)
            .bind(issue)
            .execute(&mut *c)
            .await?;
        entry["files"][index]["fileId"] = self.input["fileId"].clone();
        entry["files"][index]["data"] = json!("");
        let updated = target(c, a, &entry, &issue.to_string(), false, self.options)
            .await?
            .ok_or(StoreError::Forbidden)?;
        let previous = hash(&row);
        if entry["targetFingerprint"] == previous {
            entry["targetFingerprint"] = updated["fingerprint"].clone();
        }
        review::advance_file_alias(c, a, &entry, &previous, text(&updated, "fingerprint")).await?;
        m["entries"][position] = entry.clone();
        save(c, &mut m).await?;
        Ok(result(&m,&entry,vec![OutboxEvent{topic:"issue.file.attached".into(),payload:json!({"issueId":issue,"fileIds":[file_id],"history":{"version":1,"origin":"import"}}).as_object().unwrap().clone()}]))
    }
}
pub async fn finalize_file(
    db: &Database,
    a: &Actor,
    input: Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let input = request(a, input, "file")?;
    let key = format!(
        "import-file:{}:{}:{}:{}",
        text(&input, "id"),
        text(&input, "entryId"),
        input["index"],
        text(&input, "fileId")
    );
    let body = json!({"id":input["id"],"entryId":input["entryId"],"index":input["index"],"fileId":input["fileId"]});
    commands::execute(
        db,
        a,
        Command {
            key: &key,
            operation: "imports.file@1",
            input: &body,
            status: 200,
        },
        &Finalize {
            input: &input,
            options,
        },
    )
    .await?;
    reread(db, a, id(&input, "id")?, options).await
}

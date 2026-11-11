use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, sqlx::FromRow)]
pub(super) struct Attachment {
    pub id: Uuid,
    pub workspace_id: String,
    pub user_id: String,
    pub name: String,
    pub content_type: String,
    pub size_bytes: i32,
    pub storage_reference: String,
    pub checksum: String,
    pub expires_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}
impl Attachment {
    pub fn public(&self) -> Value {
        json!({"id":self.id,"name":self.name,"contentType":self.content_type,"sizeBytes":self.size_bytes,"checksum":self.checksum,"expiresAt":iso(self.expires_at),"createdAt":iso(self.created_at)})
    }
}
#[derive(Clone, Debug, Deserialize, sqlx::FromRow)]
pub(super) struct Artifact {
    pub id: Uuid,
    pub run_id: Uuid,
    pub kind: String,
    pub name: String,
    pub content_type: String,
    pub size_bytes: i32,
    pub storage_reference: String,
    pub checksum: String,
    pub retention_expires_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}
impl Artifact {
    pub fn public(&self) -> Value {
        json!({"id":self.id,"runId":self.run_id,"kind":self.kind,"name":self.name,"contentType":self.content_type,"sizeBytes":self.size_bytes,"checksum":self.checksum,"retentionExpiresAt":optional_iso(self.retention_expires_at),"deletedAt":optional_iso(self.deleted_at),"createdAt":iso(self.created_at)})
    }
}
pub(super) async fn attachments(
    connection: &mut PgConnection,
    actor: &Actor,
    ids: &[Uuid],
) -> Result<Vec<Attachment>, StoreError> {
    Ok(sqlx::query_as("SELECT * FROM agent_attachments WHERE workspace_id=$1 AND user_id=$2 AND id=ANY($3) AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM member m WHERE m.organization_id=$1 AND m.user_id=$2)").bind(&actor.workspace_id).bind(&actor.user_id).bind(ids).fetch_all(connection).await?)
}
pub(super) async fn insert_attachment(
    connection: &mut PgConnection,
    row: &Attachment,
) -> Result<Attachment, StoreError> {
    Ok(sqlx::query_as("INSERT INTO agent_attachments(id,workspace_id,user_id,name,content_type,size_bytes,storage_reference,checksum,expires_at,deleted_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *")
        .bind(row.id).bind(&row.workspace_id).bind(&row.user_id).bind(&row.name).bind(&row.content_type).bind(row.size_bytes).bind(&row.storage_reference).bind(&row.checksum).bind(row.expires_at).bind(row.deleted_at).bind(row.created_at).fetch_one(connection).await?)
}
pub(super) async fn existing_artifact(
    connection: &mut PgConnection,
    run: Uuid,
    hash: &str,
    name: &str,
) -> Result<Option<Artifact>, StoreError> {
    Ok(sqlx::query_as(
        "SELECT * FROM agent_artifacts WHERE run_id=$1 AND checksum=$2 AND name=$3 LIMIT 1",
    )
    .bind(run)
    .bind(hash)
    .bind(name)
    .fetch_optional(connection)
    .await?)
}
pub(super) async fn insert_artifact(
    connection: &mut PgConnection,
    row: &Artifact,
) -> Result<Artifact, StoreError> {
    Ok(sqlx::query_as("INSERT INTO agent_artifacts(id,run_id,kind,name,content_type,size_bytes,storage_reference,checksum,retention_expires_at,deleted_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *")
        .bind(row.id).bind(row.run_id).bind(&row.kind).bind(&row.name).bind(&row.content_type).bind(row.size_bytes).bind(&row.storage_reference).bind(&row.checksum).bind(row.retention_expires_at).bind(row.deleted_at).bind(row.created_at).fetch_one(connection).await?)
}
pub(super) async fn artifact(
    connection: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    now: DateTime<Utc>,
) -> Result<Artifact, StoreError> {
    let row = crate::files::artifact_metadata(connection, actor, id, false)
        .await?
        .map(serde_json::from_value::<Artifact>)
        .transpose()
        .map_err(|_| StoreError::InvalidInput)?
        .filter(|row| {
            row.deleted_at.is_none() && row.retention_expires_at.is_none_or(|at| at > now)
        });
    row.ok_or_else(|| error(Code::ArtifactNotFound, "The artifact was not found."))
}

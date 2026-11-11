use super::*;
use sha2::{Digest, Sha256};

fn local_connection(actor: &Actor) -> Uuid {
    let bytes = Sha256::digest(forge_core::canonical::javascript_stringify(&json!([
        "forge-local-codex",
        actor.workspace_id,
        actor.user_id
    ])));
    let mut id: [u8; 16] = bytes[..16].try_into().unwrap();
    id[6] = (id[6] & 0x0f) | 0x50;
    id[8] = (id[8] & 0x3f) | 0x80;
    Uuid::from_bytes(id)
}
impl Service {
    async fn connection(
        &self,
        tx: &mut JournalTransaction,
        actor: &Actor,
        id: Uuid,
    ) -> Result<Uuid, StoreError> {
        let id = if id.to_string() == CODEX_LOCAL_CONNECTION_ID {
            let id = local_connection(actor);
            tx.prepare().await?;
            sqlx::query("INSERT INTO model_connections(id,workspace_id,user_id,created_by_user_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,status,metadata) VALUES($1,$2,$3,$3,'personal','openai','local-agent','external-agent','local-only','subscription','provider-process','Codex subscription','ready','{\"source\":\"desktop-codex\"}') ON CONFLICT DO NOTHING")
                .bind(id).bind(&actor.workspace_id).bind(&actor.user_id).execute(&mut **tx).await?;
            id
        } else {
            id
        };
        let visible:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM model_connections WHERE id=$1 AND workspace_id=$2 AND (scope='workspace' OR user_id=$3))").bind(id).bind(&actor.workspace_id).bind(&actor.user_id).fetch_one(&mut **tx).await?;
        if !visible {
            return Err(StoreError::Forbidden);
        }
        Ok(id)
    }
    fn public_preference(&self, actor: &Actor, mut preference: Preference) -> Preference {
        if preference.selected_connection_id == Some(local_connection(actor)) {
            preference.selected_connection_id = CODEX_LOCAL_CONNECTION_ID.parse().ok();
        }
        preference
    }
    pub async fn get_preference(&self, actor: &Actor, id: Uuid) -> Result<Preference, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsRead, false).await?;
        let thread = self.owned_thread(&mut tx, &actor, id, false).await?;
        let pref = preferences::get_in(&mut tx, id)
            .await?
            .unwrap_or(Preference {
                thread_id: id,
                mode: SelectionMode::Auto,
                selected_connection_id: None,
                selected_model_id: None,
                selected_effort: None,
                updated_at: thread.updated_at,
            });
        tx.commit().await?;
        Ok(self.public_preference(&actor, pref))
    }
    pub(super) async fn preference_in(
        &self,
        tx: &mut JournalTransaction,
        actor: &Actor,
        id: Uuid,
        input: Value,
    ) -> Result<Preference, StoreError> {
        let input = models::preference(input).map_err(|_| StoreError::InvalidInput)?;
        let connection = if input["selectedConnectionId"].is_null() {
            None
        } else {
            Some(
                self.connection(tx, actor, parse_id(&input["selectedConnectionId"])?)
                    .await?,
            )
        };
        preferences::upsert_in(
            tx,
            &Preference {
                thread_id: id,
                mode: decode(input["mode"].clone())?,
                selected_connection_id: connection,
                selected_model_id: decode(input["selectedModelId"].clone())?,
                selected_effort: decode(input["selectedEffort"].clone())?,
                updated_at: self.time(),
            },
        )
        .await
    }
    pub async fn set_preference(
        &self,
        actor: &Actor,
        id: Uuid,
        input: Value,
    ) -> Result<Preference, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, true).await?;
        self.owned_thread(&mut tx, &actor, id, true).await?;
        let pref = self.preference_in(&mut tx, &actor, id, input).await?;
        tx.commit().await?;
        Ok(self.public_preference(&actor, pref))
    }
    pub(super) async fn local_connection(
        &self,
        tx: &mut JournalTransaction,
        actor: &Actor,
        model: &Value,
    ) -> Result<Uuid, StoreError> {
        let id = self
            .connection(tx, actor, parse_id(&model["connectionId"])?)
            .await?;
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM model_connections WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND scope='personal' AND kind='local-agent' AND execution_kind='external-agent' AND locality='local-only' AND credential_owner='provider-process' AND provider=$4 AND status='ready')").bind(id).bind(&actor.workspace_id).bind(&actor.user_id).bind(model["provider"].as_str().unwrap()).fetch_one(&mut **tx).await?;
        if !valid {
            return Err(error(
                "RUNTIME_UNAVAILABLE",
                "The selected local agent connection is unavailable.",
            ));
        }
        Ok(id)
    }
}

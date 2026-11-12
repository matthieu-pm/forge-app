use super::*;
use chrono::{Duration, Utc};
use serde_json::json;
#[tokio::test]
async fn meeting_sync_and_summary_require_acknowledged_claims_and_keep_committed_results_on_publish_failure()
 {
    use forge_core::calls::providers::{Error, Exchange, Gateway, NativeCall, Summarizer, Tokens};
    use std::{
        collections::HashMap,
        sync::atomic::{AtomicBool, AtomicI64, AtomicUsize},
    };
    struct Probe {
        backend: Arc<CaptureJournal>,
        refreshes: AtomicUsize,
        reads: AtomicUsize,
        summaries: AtomicUsize,
        fail_publication: AtomicBool,
    }
    #[async_trait]
    impl Gateway for Probe {
        fn authorization_url(&self, _: &str, _: &str, _: &str) -> Result<String, Error> {
            Err(Error)
        }
        async fn exchange(&self, _: &str, _: Exchange<'_>) -> Result<Tokens, Error> {
            self.refreshes.fetch_add(1, Ordering::SeqCst);
            if self.fail_publication.load(Ordering::SeqCst) {
                self.backend.mode.store(2, Ordering::SeqCst);
            }
            Ok(Tokens {
                access_token: "private-refreshed-access".into(),
                refresh_token: Some("private-refresh".into()),
                expires_at: 4102444800000.,
            })
        }
        async fn native_calls(
            &self,
            _: &str,
            _: &str,
            _: chrono::DateTime<Utc>,
        ) -> Result<Vec<NativeCall>, Error> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(vec![])
        }
    }
    #[async_trait]
    impl Summarizer for Probe {
        async fn summarize(&self, _: &str) -> Result<serde_json::Value, Error> {
            self.summaries.fetch_add(1, Ordering::SeqCst);
            if self.fail_publication.load(Ordering::SeqCst) {
                self.backend.mode.store(2, Ordering::SeqCst);
            }
            Ok(
                json!({"summary":"Decision","decisions":["Start"],"actions":[{"title":"Prepare","owner":"Sam"}]}),
            )
        }
    }
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Call pipeline recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Calls","identifier":"PREC","timezone":"UTC","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"}})).unwrap()).await.unwrap();
    let clock = Arc::new(AtomicI64::new(Utc::now().timestamp_millis()));
    let time = clock.clone();
    let mut service = forge_store::calls::Service::new(
        f.database.clone(),
        forge_store::calls::Options {
            environment: HashMap::from([("FORGE_CALLS_PROVIDERS".into(), "google".into())]),
        },
    );
    service.now = Arc::new(move || {
        chrono::DateTime::from_timestamp_millis(time.load(Ordering::SeqCst)).unwrap()
    });
    service.vault = Some(Arc::new(
        forge_identity::model_vault::Vault::new("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
            .unwrap(),
    ));
    let probe = Arc::new(Probe {
        backend: f.backend.clone(),
        refreshes: 0.into(),
        reads: 0.into(),
        summaries: 0.into(),
        fail_publication: false.into(),
    });
    service.gateway = Some(probe.clone());
    service.summarizer = Some(probe.clone());
    let id = Uuid::new_v4();
    let secret=service.vault.as_ref().unwrap().seal(&json!({"access_token":"private-access","refresh_token":"private-refresh","expires_at":0}).to_string(),&format!("meeting:{}:{id}",actor.workspace_id)).unwrap();
    sqlx::query("INSERT INTO call_connections(id,workspace_id,user_id,team_id,provider,secret) VALUES($1,$2,$3,$4,'google',$5)").bind(id).bind(&actor.workspace_id).bind(&actor.user_id).bind(team.id).bind(secret).execute(&f.pool).await.unwrap();
    let call=service.import(&actor,json!({"teamId":team.id,"title":"Review","startedAt":forge_core::loops::iso_timestamp((service.now)()),"text":"Alex: Private transcript","consentConfirmed":true})).await.unwrap();
    for mode in [1, 2] {
        f.backend.mode.store(mode, Ordering::SeqCst);
        assert!(matches!(
            service.sync_connection(id, None).await,
            Err(StoreError::Recovery(_))
        ));
        assert!(matches!(
            service.summarize_call(call, None).await,
            Err(StoreError::Recovery(_))
        ));
        let leases:(bool,bool)=sqlx::query_as("SELECT (SELECT sync_lease_at IS NOT NULL FROM call_connections WHERE id=$1),(SELECT summary_lease_at IS NOT NULL FROM calls WHERE id=$2)").bind(id).bind(call).fetch_one(&f.pool).await.unwrap();
        assert_eq!(leases, (mode == 2, mode == 2));
    }
    assert_eq!(
        probe.reads.load(Ordering::SeqCst)
            + probe.refreshes.load(Ordering::SeqCst)
            + probe.summaries.load(Ordering::SeqCst),
        0
    );
    clock.fetch_add(16 * 60 * 1000, Ordering::SeqCst);
    f.backend.mode.store(0, Ordering::SeqCst);
    probe.fail_publication.store(true, Ordering::SeqCst);
    assert!(matches!(
        service.sync_connection(id, None).await,
        Err(StoreError::Recovery(_))
    ));
    assert_eq!(probe.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(probe.reads.load(Ordering::SeqCst), 0);
    let secret: String = sqlx::query_scalar("SELECT secret FROM call_connections WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(
        service
            .vault
            .as_ref()
            .unwrap()
            .open(&secret, &format!("meeting:{}:{id}", actor.workspace_id))
            .unwrap()
            .contains("private-refreshed-access")
    );
    f.backend.mode.store(0, Ordering::SeqCst);
    assert!(matches!(
        service.summarize_call(call, None).await,
        Err(StoreError::Recovery(_))
    ));
    let state:(String,String,Option<chrono::DateTime<Utc>>,i64)=sqlx::query_as("SELECT summary,summary_status,summary_lease_at,(SELECT count(*) FROM call_actions WHERE call_id=c.id) FROM calls c WHERE id=$1").bind(call).fetch_one(&f.pool).await.unwrap();
    assert_eq!(state, ("Decision".into(), "ready".into(), None, 1));
    f.backend.mode.store(0, Ordering::SeqCst);
    probe.fail_publication.store(false, Ordering::SeqCst);
    assert!(!service.summarize_call(call, None).await.unwrap());
    assert_eq!(probe.summaries.load(Ordering::SeqCst), 1);
    assert_eq!(service.sync_connection(id, None).await.unwrap(), 0);
    assert_eq!(probe.refreshes.load(Ordering::SeqCst), 1);
    let patches:Vec<serde_json::Value>=sqlx::query_scalar("SELECT patch FROM recovery_events WHERE table_name='call_connections' AND row_key->>'id'=$1 ORDER BY sequence").bind(id.to_string()).fetch_all(&f.pool).await.unwrap();
    assert_eq!(patches, vec![json!({"secret":null})]);
}
#[tokio::test]
async fn call_retention_requires_independent_preparation_and_keeps_committed_redaction_on_publication_failure()
 {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Call retention recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Recovery calls","identifier":"REC","timezone":"UTC","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"}})).unwrap()).await.unwrap();
    let service = forge_store::calls::Service::new(f.database.clone(), Default::default());
    let call=service.import(&actor,json!({"teamId":team.id,"title":"Private call","startedAt":forge_core::loops::iso_timestamp(Utc::now()-Duration::days(20)),"text":"Alex: private-transcript-content","consentConfirmed":true})).await.unwrap();
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service.save_retention(&actor, json!({"days":7})).await,
        Err(StoreError::Recovery(_))
    ));
    let state: (String, serde_json::Value) =
        sqlx::query_as("SELECT status,transcript FROM calls WHERE id=$1")
            .bind(call)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(state.0, "ready");
    assert_eq!(state.1[0]["text"], "private-transcript-content");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM call_settings WHERE workspace_id=$1")
        .bind(&actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(matches!(
        service.save_retention(&actor, json!({"days":7})).await,
        Err(StoreError::Recovery(_))
    ));
    let state: (String, serde_json::Value) =
        sqlx::query_as("SELECT status,transcript FROM calls WHERE id=$1")
            .bind(call)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(state, ("expired".into(), json!([])));
    let records:Vec<serde_json::Value>=sqlx::query_scalar("SELECT jsonb_build_object('table',e.table_name,'action',e.action,'patch',e.patch,'published',o.published_at IS NOT NULL) FROM recovery_events e JOIN recovery_operations o ON o.id=e.operation_id WHERE (e.table_name='call_settings' AND e.row_key->>'workspace_id'=$1) OR (e.table_name='calls' AND e.row_key->>'id'=$2) ORDER BY e.sequence")
        .bind(&actor.workspace_id).bind(call.to_string()).fetch_all(&f.pool).await.unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(
        records[0],
        json!({"table":"call_settings","action":"upsert","patch":{"retention_days":7},"published":false})
    );
    assert_eq!(
        records[1],
        json!({"table":"calls","action":"patch","patch":{"status":"expired","transcript":[]},"published":false})
    );
    assert!(
        !json!(records)
            .to_string()
            .contains("private-transcript-content")
    );
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(service.sweep(Some(&actor.workspace_id)).await.unwrap(), 0);
    assert_eq!(
        service.read(&actor, json!({"callId":call})).await.unwrap()["transcript"],
        json!([])
    );
}

#[tokio::test]
async fn meeting_oauth_requires_acknowledged_claims_before_exchange_and_keeps_credentials_out_of_recovery()
 {
    use forge_core::calls::providers::{Error, Exchange, Gateway, Tokens};
    use std::{collections::HashMap, sync::atomic::AtomicUsize};
    struct Probe {
        calls: AtomicUsize,
        backend: Arc<CaptureJournal>,
        fail_publication: std::sync::atomic::AtomicBool,
    }
    #[async_trait]
    impl Gateway for Probe {
        fn authorization_url(&self, _: &str, state: &str, _: &str) -> Result<String, Error> {
            Ok(format!(
                "https://accounts.google.com/o/oauth2/v2/auth?state={state}"
            ))
        }
        async fn exchange(&self, _: &str, _: Exchange<'_>) -> Result<Tokens, Error> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_publication.load(Ordering::SeqCst) {
                self.backend.mode.store(2, Ordering::SeqCst);
            }
            Ok(Tokens {
                access_token: "private-meeting-token".into(),
                refresh_token: None,
                expires_at: 1893459600000.,
            })
        }
    }
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "OAuth recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Meeting recovery","identifier":"MREC","timezone":"UTC","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"}})).unwrap()).await.unwrap();
    let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    let mut service = forge_store::calls::Service::new(
        f.database.clone(),
        forge_store::calls::Options {
            environment: HashMap::from([
                (
                    "BETTER_AUTH_URL".into(),
                    "https://forge.example.test".into(),
                ),
                ("FORGE_MODEL_CREDENTIAL_KEK".into(), key.into()),
                ("FORGE_GOOGLE_MEET_CLIENT_ID".into(), "fixture-id".into()),
                (
                    "FORGE_GOOGLE_MEET_CLIENT_SECRET".into(),
                    "fixture-secret".into(),
                ),
            ]),
        },
    );
    let probe = Arc::new(Probe {
        calls: AtomicUsize::new(0),
        backend: f.backend.clone(),
        fail_publication: false.into(),
    });
    service.gateway = Some(probe.clone());
    service.vault = Some(Arc::new(
        forge_identity::model_vault::Vault::new(key).unwrap(),
    ));
    let input = json!({"teamId":team.id,"provider":"google","consentConfirmed":true});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service.begin_connection(&actor, input.clone()).await,
        Err(StoreError::Recovery(_))
    ));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM call_connections WHERE workspace_id=$1")
            .bind(&actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(0, Ordering::SeqCst);
    let url = service
        .begin_connection(&actor, input.clone())
        .await
        .unwrap();
    let ticket = url.split("state=").nth(1).unwrap();
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service
            .finish_connection(&actor, ticket, "private-code")
            .await,
        Err(StoreError::Recovery(_))
    ));
    let pending:bool=sqlx::query_scalar("SELECT oauth_verifier IS NOT NULL AND oauth_expires_at IS NOT NULL FROM call_connections WHERE workspace_id=$1").bind(&actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert!(pending);
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(matches!(
        service
            .finish_connection(&actor, ticket, "private-code")
            .await,
        Err(StoreError::Recovery(_))
    ));
    assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
    f.backend.mode.store(0, Ordering::SeqCst);
    assert!(
        service
            .finish_connection(&actor, ticket, "retry")
            .await
            .is_err()
    );
    let url = service.begin_connection(&actor, input).await.unwrap();
    let ticket = url.split("state=").nth(1).unwrap();
    probe.fail_publication.store(true, Ordering::SeqCst);
    assert!(matches!(
        service
            .finish_connection(&actor, ticket, "private-code")
            .await,
        Err(StoreError::Recovery(_))
    ));
    assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
    let (id, secret, hash): (Uuid, String, Option<String>) = sqlx::query_as(
        "SELECT id,secret,oauth_state_hash FROM call_connections WHERE workspace_id=$1",
    )
    .bind(&actor.workspace_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(hash.is_none());
    assert!(!secret.contains("private-meeting-token"));
    assert!(
        forge_identity::model_vault::Vault::new(key)
            .unwrap()
            .open(&secret, &format!("meeting:{}:{id}", actor.workspace_id))
            .unwrap()
            .contains("private-meeting-token")
    );
    let rows:Vec<serde_json::Value>=sqlx::query_scalar("SELECT to_jsonb(e) FROM recovery_events e WHERE e.table_name='call_connections' AND e.row_key->>'id'=$1 ORDER BY e.sequence").bind(id.to_string()).fetch_all(&f.pool).await.unwrap();
    // The owning deletion journal records credential revocation as null patches.
    // Replaying them must never restore an OAuth verifier or either credential.
    assert_eq!(
        json!(rows.iter().map(|r| &r["patch"]).collect::<Vec<_>>()),
        json!([
            {"oauth_verifier":null},
            {"oauth_verifier":null,"oauth_state_hash":null},
            {"oauth_verifier":null},
            {"secret":null,"oauth_state_hash":null}
        ])
    );
    assert!(rows.iter().all(|r| r["action"] == "patch"));
    assert!(!json!(rows).to_string().contains("private-"));
    f.backend.mode.store(0, Ordering::SeqCst);
}

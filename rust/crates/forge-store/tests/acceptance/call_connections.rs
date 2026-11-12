use super::*;
use forge_core::calls::providers::{Config, Error, Exchange, Gateway, Tokens};
use forge_store::calls::{Options, Service};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{sync::Notify, time::timeout};
const KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
fn environment() -> HashMap<String, String> {
    let mut env = HashMap::from([
        (
            "BETTER_AUTH_URL".into(),
            "https://forge.example.test".into(),
        ),
        ("FORGE_MODEL_CREDENTIAL_KEK".into(), KEY.into()),
    ]);
    for prefix in forge_core::calls::PREFIXES {
        env.insert(format!("FORGE_{prefix}_CLIENT_ID"), "fixture-id".into());
        env.insert(
            format!("FORGE_{prefix}_CLIENT_SECRET"),
            "fixture-secret".into(),
        );
    }
    env
}
#[derive(Default)]
struct Probe {
    calls: AtomicUsize,
    hold: AtomicBool,
    fail: AtomicBool,
    entered: Notify,
    release: Notify,
}
#[async_trait]
impl Gateway for Probe {
    fn authorization_url(&self, p: &str, s: &str, c: &str) -> Result<String, Error> {
        Ok(Config::new(&environment(), p)?.authorization_url(s, c))
    }
    async fn exchange(&self, _: &str, input: Exchange<'_>) -> Result<Tokens, Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if self.hold.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error);
        }
        let Exchange::Code { code, verifier } = input else {
            panic!("code exchange")
        };
        assert_eq!(verifier.len(), 43);
        Ok(Tokens {
            access_token: format!("private-token-{code}"),
            refresh_token: Some("private-refresh".into()),
            expires_at: 1893459600000.,
        })
    }
}
fn service(f: &Fixture) -> (Service, Arc<Probe>) {
    let probe = Arc::new(Probe::default());
    let mut service = Service::new(
        f.database.clone(),
        Options {
            environment: environment(),
        },
    );
    service.gateway = Some(probe.clone());
    service.vault = Some(Arc::new(
        forge_identity::model_vault::Vault::new(KEY).unwrap(),
    ));
    (service, probe)
}
fn state(url: &str) -> String {
    url.split('?')
        .nth(1)
        .unwrap()
        .split('&')
        .find_map(|p| p.strip_prefix("state="))
        .unwrap()
        .into()
}
async fn begin(s: &Service, a: &Actor, team: Uuid, provider: &str) -> String {
    state(
        &s.begin_connection(
            a,
            json!({"teamId":team,"provider":provider,"consentConfirmed":true}),
        )
        .await
        .unwrap(),
    )
}
async fn stored(
    f: &Fixture,
) -> (
    Uuid,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<chrono::DateTime<chrono::Utc>>,
) {
    sqlx::query_as("SELECT id,secret,oauth_state_hash,oauth_verifier,oauth_expires_at FROM call_connections WHERE workspace_id=$1 ORDER BY provider LIMIT 1")
        .bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap()
}
#[tokio::test]
async fn meeting_connections_bind_single_use_states_and_encrypted_tokens_to_the_current_owner() {
    let f = Fixture::new().await;
    let (s, probe) = service(&f);
    let team = issue_acceptance::team(&f, 140).await;
    for provider in forge_core::calls::PROVIDERS {
        let ticket = begin(&s, &f.actor, team, provider).await;
        let (id,hash,verifier):(Uuid,String,String)=sqlx::query_as("SELECT id,oauth_state_hash,oauth_verifier FROM call_connections WHERE workspace_id=$1 AND provider=$2")
            .bind(&f.actor.workspace_id).bind(provider).fetch_one(&f.pool).await.unwrap();
        use sha2::Digest;
        assert_eq!(
            hash,
            format!("{:x}", sha2::Sha256::digest(ticket.as_bytes()))
        );
        assert_ne!(hash, ticket);
        assert_eq!(verifier.len(), 43);
        let (a, b) = tokio::join!(
            s.finish_connection(&f.actor, &ticket, "first"),
            s.finish_connection(&f.actor, &ticket, "first")
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        let (secret,hash,verifier,expires):(String,Option<String>,Option<String>,Option<chrono::DateTime<chrono::Utc>>)=sqlx::query_as("SELECT secret,oauth_state_hash,oauth_verifier,oauth_expires_at FROM call_connections WHERE id=$1").bind(id).fetch_one(&f.pool).await.unwrap();
        assert!(!secret.contains("private-token"));
        assert!(hash.is_none() && verifier.is_none() && expires.is_none());
        let vault = forge_identity::model_vault::Vault::new(KEY).unwrap();
        let plain = vault
            .open(&secret, &format!("meeting:{}:{id}", f.actor.workspace_id))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&plain).unwrap()["access_token"],
            "private-token-first"
        );
        assert!(vault.open(&secret, &format!("meeting:other:{id}")).is_err());
    }
    assert_eq!(probe.calls.load(Ordering::SeqCst), 3);
    let projection = s.list(&f.actor, json!({})).await.unwrap().to_string();
    assert!(
        !projection.contains("private-token")
            && !projection.contains("private-refresh")
            && !projection.contains("oauth")
    );
}
#[tokio::test]
async fn meeting_connection_authority_consent_expiry_and_failed_exchange_do_not_replay() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let (mut s, probe) = service(&f);
    let team = issue_acceptance::team(&f, 141).await;
    let args = json!({"teamId":team,"provider":"google","consentConfirmed":true});
    assert!(matches!(
        s.begin_connection(&member, args.clone()).await,
        Err(StoreError::Forbidden)
    ));
    let mut no_consent = args.clone();
    no_consent["consentConfirmed"] = json!(false);
    assert!(matches!(
        s.begin_connection(&f.actor, no_consent).await,
        Err(StoreError::InvalidInput)
    ));
    let mut missing = s.clone();
    missing.vault = None;
    assert!(missing.begin_connection(&f.actor, args).await.is_err());
    let now =
        chrono::DateTime::from_timestamp_millis(chrono::Utc::now().timestamp_millis()).unwrap();
    s.now = Arc::new(move || now);
    let old = begin(&s, &f.actor, team, "google").await;
    s.now =
        Arc::new(move || now + chrono::Duration::minutes(10) + chrono::Duration::milliseconds(1));
    assert!(matches!(
        s.finish_connection(&f.actor, &old, "expired").await,
        Err(StoreError::Call(_))
    ));
    assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
    s.now = Arc::new(move || now + chrono::Duration::minutes(10));
    s.finish_connection(&f.actor, &old, "boundary")
        .await
        .unwrap();
    let fresh = begin(&s, &f.actor, team, "google").await;
    let unrelated = Fixture::new().await;
    assert!(
        s.finish_connection(&unrelated.actor, &fresh, "wrong-workspace")
            .await
            .is_err()
    );
    sqlx::query("UPDATE member SET role='admin' WHERE organization_id=$1 AND user_id=$2")
        .bind(&member.workspace_id)
        .bind(&member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        s.finish_connection(&member, &fresh, "wrong-owner")
            .await
            .is_err()
    );
    probe.fail.store(true, Ordering::SeqCst);
    assert!(
        s.finish_connection(&f.actor, &fresh, "failed")
            .await
            .is_err()
    );
    assert!(
        s.finish_connection(&f.actor, &fresh, "retry")
            .await
            .is_err()
    );
    assert_eq!(probe.calls.load(Ordering::SeqCst), 2);
    let (_, secret, hash, verifier, expires) = stored(&f).await;
    assert!(secret.is_some() && hash.is_some() && verifier.is_none() && expires.is_none());
}
#[tokio::test]
async fn a_new_meeting_connection_attempt_fences_an_older_inflight_callback() {
    let f = Fixture::new().await;
    let (s, probe) = service(&f);
    let team = issue_acceptance::team(&f, 142).await;
    let first = begin(&s, &f.actor, team, "google").await;
    probe.hold.store(true, Ordering::SeqCst);
    let task = {
        let s = s.clone();
        let a = f.actor.clone();
        tokio::spawn(async move { s.finish_connection(&a, &first, "old").await })
    };
    timeout(Duration::from_secs(3), probe.entered.notified())
        .await
        .unwrap();
    let replacement_team = issue_acceptance::team(&f, 144).await;
    let replacement = begin(&s, &f.actor, replacement_team, "google").await;
    let before = stored(&f).await;
    probe.release.notify_one();
    assert!(task.await.unwrap().is_err());
    assert_eq!(stored(&f).await, before);
    let current_team: Uuid =
        sqlx::query_scalar("SELECT team_id FROM call_connections WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(current_team, replacement_team);
    probe.hold.store(false, Ordering::SeqCst);
    s.finish_connection(&f.actor, &replacement, "new")
        .await
        .unwrap();
    let (id, secret, ..) = stored(&f).await;
    let plain = forge_identity::model_vault::Vault::new(KEY)
        .unwrap()
        .open(
            &secret.unwrap(),
            &format!("meeting:{}:{id}", f.actor.workspace_id),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&plain).unwrap()["access_token"],
        "private-token-new"
    );
}
#[tokio::test]
async fn meeting_callbacks_reauthorize_after_exchange_and_cannot_restore_disconnected_credentials()
{
    for change in ["role", "team", "session", "disconnect"] {
        let f = Fixture::new().await;
        let (s, probe) = service(&f);
        let team = issue_acceptance::team(&f, 143).await;
        let ticket = begin(&s, &f.actor, team, "google").await;
        probe.hold.store(true, Ordering::SeqCst);
        let task = {
            let s = s.clone();
            let a = f.actor.clone();
            tokio::spawn(async move { s.finish_connection(&a, &ticket, "late").await })
        };
        timeout(Duration::from_secs(3), probe.entered.notified())
            .await
            .unwrap();
        match change {
            "role" => {
                sqlx::query(
                    "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
                )
                .bind(&f.actor.workspace_id)
                .bind(&f.actor.user_id)
                .execute(&f.pool)
                .await
                .unwrap();
            }
            "team" => {
                sqlx::query("UPDATE teams SET deleted_at=clock_timestamp() WHERE id=$1")
                    .bind(team)
                    .execute(&f.pool)
                    .await
                    .unwrap();
            }
            "session" => {
                sqlx::query("UPDATE session SET active_organization_id=NULL WHERE user_id=$1")
                    .bind(&f.actor.user_id)
                    .execute(&f.pool)
                    .await
                    .unwrap();
            }
            "disconnect" => {
                let (id, ..) = stored(&f).await;
                s.disconnect(&f.actor, json!({"id":id})).await.unwrap();
            }
            _ => unreachable!(),
        }
        probe.release.notify_one();
        assert!(task.await.unwrap().is_err(), "{change}");
        let saved: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM call_connections WHERE workspace_id=$1 AND secret IS NOT NULL",
        )
        .bind(&f.actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
        assert_eq!(saved, 0, "{change}");
    }
}

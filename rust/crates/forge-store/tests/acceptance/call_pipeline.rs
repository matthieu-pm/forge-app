use super::*;
use chrono::{DateTime, Duration, Utc};
use forge_core::calls::{
    TranscriptEntry,
    providers::{Error, Exchange, Gateway, NativeCall, Summarizer, Tokens},
};
use forge_store::calls::{Options, Service};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    },
    time::Duration as Wait,
};
use tokio::{sync::Notify, time::timeout};
const KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
#[derive(Default)]
struct Probe {
    reads: AtomicUsize,
    refreshes: AtomicUsize,
    summaries: AtomicUsize,
    hold: AtomicBool,
    fail: AtomicBool,
    entered: Notify,
    release: Notify,
    records: Mutex<Vec<NativeCall>>,
    since: Mutex<Vec<DateTime<Utc>>>,
    texts: Mutex<Vec<String>>,
    recap: Mutex<Option<Value>>,
}
impl Probe {
    async fn pause(&self) -> Result<(), Error> {
        self.entered.notify_one();
        if self.hold.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        if self.fail.load(Ordering::SeqCst) {
            Err(Error)
        } else {
            Ok(())
        }
    }
    async fn wait(&self) {
        timeout(Wait::from_secs(10), self.entered.notified())
            .await
            .unwrap();
    }
}
#[async_trait]
impl Gateway for Probe {
    fn authorization_url(&self, _: &str, _: &str, _: &str) -> Result<String, Error> {
        Err(Error)
    }
    async fn exchange(&self, provider: &str, input: Exchange<'_>) -> Result<Tokens, Error> {
        assert_eq!(provider, "google");
        let Exchange::Refresh { refresh_token } = input else {
            panic!("refresh expected");
        };
        assert_eq!(refresh_token, "private-refresh");
        self.refreshes.fetch_add(1, Ordering::SeqCst);
        Ok(Tokens {
            access_token: "private-new-access".into(),
            refresh_token: Some(refresh_token.into()),
            expires_at: 4102444800000.,
        })
    }
    async fn native_calls(
        &self,
        provider: &str,
        token: &str,
        since: DateTime<Utc>,
    ) -> Result<Vec<NativeCall>, Error> {
        assert_eq!(provider, "google");
        assert!(token.starts_with("private-"));
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.since.lock().unwrap().push(since);
        self.pause().await?;
        Ok(self.records.lock().unwrap().clone())
    }
}
#[async_trait]
impl Summarizer for Probe {
    async fn summarize(&self, text: &str) -> Result<Value, Error> {
        self.summaries.fetch_add(1, Ordering::SeqCst);
        self.texts.lock().unwrap().push(text.into());
        self.pause().await?;
        Ok(self.recap.lock().unwrap().clone().unwrap_or_else(|| json!({"summary":"Pilot approved.","decisions":["Start small"],"actions":[{"title":"Prepare pilot","owner":"Sam"},{"title":"Review result","owner":""}]})))
    }
}
fn setup(f: &Fixture) -> (Service, Arc<Probe>, Arc<AtomicI64>) {
    let probe = Arc::new(Probe::default());
    let clock = Arc::new(AtomicI64::new(Utc::now().timestamp_millis()));
    let mut service = Service::new(
        f.database.clone(),
        Options {
            environment: HashMap::from([("FORGE_CALLS_PROVIDERS".into(), "google".into())]),
        },
    );
    service.gateway = Some(probe.clone());
    service.summarizer = Some(probe.clone());
    service.vault = Some(Arc::new(
        forge_identity::model_vault::Vault::new(KEY).unwrap(),
    ));
    let time = clock.clone();
    service.now =
        Arc::new(move || DateTime::from_timestamp_millis(time.load(Ordering::SeqCst)).unwrap());
    (service, probe, clock)
}
async fn connection(f: &Fixture, s: &Service, team: Uuid, expired: bool) -> Uuid {
    let id = Uuid::new_v4();
    let secret = s
        .vault
        .as_ref()
        .unwrap()
        .seal(
            &serde_json::to_string(&Tokens {
                access_token: "private-access".into(),
                refresh_token: Some("private-refresh".into()),
                expires_at: if expired { 0. } else { 4102444800000. },
            })
            .unwrap(),
            &format!("meeting:{}:{id}", f.actor.workspace_id),
        )
        .unwrap();
    sqlx::query("INSERT INTO call_connections(id,workspace_id,user_id,team_id,provider,secret) VALUES($1,$2,$3,$4,'google',$5)").bind(id).bind(&f.actor.workspace_id).bind(&f.actor.user_id).bind(team).bind(secret).execute(&f.pool).await.unwrap();
    id
}
fn record(now: DateTime<Utc>) -> NativeCall {
    NativeCall {
        external_id: "conference-1".into(),
        title: "Review".into(),
        started_at: now - Duration::hours(1),
        duration: 30,
        participants: vec!["Alex".into()],
        transcript: vec![TranscriptEntry {
            speaker: "Alex".into(),
            seconds: 12.5,
            text: "Start small.".into(),
        }],
    }
}
async fn imported(f: &Fixture, s: &Service, team: Uuid) -> Uuid {
    s.import(&f.actor,json!({"teamId":team,"title":"Review","startedAt":forge_core::loops::iso_timestamp((s.now)()),"text":"Alex: Start small.\nSam: Prepare pilot.","consentConfirmed":true})).await.unwrap()
}
async fn state(f: &Fixture, id: Uuid) -> Value {
    sqlx::query_scalar("SELECT to_jsonb(c) FROM calls c WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
#[tokio::test]
async fn sync_refreshes_encrypted_credentials_filters_old_empty_records_and_deduplicates_imports() {
    let f = Fixture::new().await;
    let (s, p, _) = setup(&f);
    let team = issue_acceptance::team(&f, 150).await;
    let id = connection(&f, &s, team, true).await;
    let valid = record((s.now)());
    let mut old = valid.clone();
    old.external_id = "old".into();
    old.started_at = (s.now)() - Duration::days(8);
    let mut empty = valid.clone();
    empty.external_id = "empty".into();
    empty.transcript.clear();
    *p.records.lock().unwrap() = vec![valid.clone(), valid, old, empty];
    assert_eq!(s.sync(&f.actor).await.unwrap(), 1);
    assert_eq!(s.sync_connection(id, None).await.unwrap(), 0);
    assert_eq!(p.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(p.since.lock().unwrap()[0], (s.now)() - Duration::days(7));
    #[derive(sqlx::FromRow)]
    struct SyncedConnection {
        secret: String,
        sync_lease_at: Option<DateTime<Utc>>,
        last_synced_at: Option<DateTime<Utc>>,
        error: Option<String>,
    }
    let SyncedConnection {
        secret,
        sync_lease_at: lease,
        last_synced_at: last,
        error,
    }: SyncedConnection = sqlx::query_as(
        "SELECT secret,sync_lease_at,last_synced_at,error FROM call_connections WHERE id=$1",
    )
    .bind(id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(!secret.contains("private-"));
    assert!(lease.is_none() && last.is_some() && error.is_none());
    let plain = s
        .vault
        .as_ref()
        .unwrap()
        .open(&secret, &format!("meeting:{}:{id}", f.actor.workspace_id))
        .unwrap();
    let tokens: Tokens = serde_json::from_str(&plain).unwrap();
    assert_eq!(tokens.access_token, "private-new-access");
    assert_eq!(tokens.refresh_token.as_deref(), Some("private-refresh"));
    let rows = s.list(&f.actor, json!({})).await.unwrap();
    assert_eq!(rows["calls"].as_array().unwrap().len(), 1);
    assert_eq!(rows["calls"][0]["summaryStatus"], "pending");
}
#[tokio::test]
async fn sync_rechecks_authority_and_connection_generation_after_external_io() {
    for change in [
        "role",
        "member",
        "session",
        "team",
        "secret",
        "attempt",
        "disconnect",
    ] {
        let f = Fixture::new().await;
        let (s, p, _) = setup(&f);
        let team = issue_acceptance::team(&f, 151).await;
        let id = connection(&f, &s, team, false).await;
        *p.records.lock().unwrap() = vec![record((s.now)())];
        p.hold.store(true, Ordering::SeqCst);
        let service = s.clone();
        let actor = f.actor.clone();
        let task = tokio::spawn(async move { service.sync_connection(id, Some(&actor)).await });
        p.wait().await;
        assert_eq!(s.sync_connection(id, Some(&f.actor)).await.unwrap(), 0);
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
            "member" => {
                sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
                    .bind(&f.actor.workspace_id)
                    .bind(&f.actor.user_id)
                    .execute(&f.pool)
                    .await
                    .unwrap();
            }
            "session" => {
                sqlx::query("DELETE FROM session WHERE token=$1")
                    .bind(&f.token)
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
            "secret" => {
                sqlx::query("UPDATE call_connections SET secret='new-generation',error='new-error' WHERE id=$1").bind(id).execute(&f.pool).await.unwrap();
            }
            "attempt" => {
                sqlx::query("UPDATE call_connections SET oauth_state_hash='new-attempt',error='new-error' WHERE id=$1").bind(id).execute(&f.pool).await.unwrap();
            }
            "disconnect" => {
                s.disconnect(&f.actor, json!({"id":id})).await.unwrap();
            }
            _ => unreachable!(),
        }
        p.release.notify_one();
        assert!(
            timeout(Wait::from_secs(10), task)
                .await
                .unwrap()
                .unwrap()
                .is_err(),
            "{change}"
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM calls WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "{change}");
        let row: Option<(Option<DateTime<Utc>>, Option<String>)> =
            sqlx::query_as("SELECT sync_lease_at,error FROM call_connections WHERE id=$1")
                .bind(id)
                .fetch_optional(&f.pool)
                .await
                .unwrap();
        if let Some((lease, error)) = row {
            assert!(lease.is_none());
            if ["secret", "attempt"].contains(&change) {
                assert_eq!(error.as_deref(), Some("new-error"));
            } else {
                assert_eq!(
                    error.as_deref(),
                    Some("Meeting sync failed. Check your connection and try again.")
                );
            }
        }
    }
}
#[tokio::test]
async fn old_sync_worker_cannot_publish_or_release_a_reclaimed_lease() {
    let f = Fixture::new().await;
    let (s, p, clock) = setup(&f);
    let team = issue_acceptance::team(&f, 152).await;
    let id = connection(&f, &s, team, false).await;
    *p.records.lock().unwrap() = vec![record((s.now)())];
    p.hold.store(true, Ordering::SeqCst);
    let service = s.clone();
    let first = tokio::spawn(async move { service.sync_connection(id, None).await });
    p.wait().await;
    clock.fetch_add(16 * 60 * 1000, Ordering::SeqCst);
    let newer = Arc::new(Probe::default());
    *newer.records.lock().unwrap() = p.records.lock().unwrap().clone();
    newer.hold.store(true, Ordering::SeqCst);
    let mut service = s.clone();
    service.gateway = Some(newer.clone());
    let second = tokio::spawn(async move { service.sync_connection(id, None).await });
    newer.wait().await;
    p.release.notify_one();
    assert!(first.await.unwrap().is_err());
    let lease: DateTime<Utc> =
        sqlx::query_scalar("SELECT sync_lease_at FROM call_connections WHERE id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(lease, (s.now)());
    newer.release.notify_one();
    assert_eq!(second.await.unwrap().unwrap(), 1);
}
#[tokio::test]
async fn sync_failure_releases_for_retry_and_rejects_disabled_or_revoked_owners_before_fetch() {
    let f = Fixture::new().await;
    let (mut s, p, _) = setup(&f);
    let team = issue_acceptance::team(&f, 153).await;
    let id = connection(&f, &s, team, false).await;
    p.fail.store(true, Ordering::SeqCst);
    assert!(s.sync_connection(id, None).await.is_err());
    p.fail.store(false, Ordering::SeqCst);
    *p.records.lock().unwrap() = vec![record((s.now)())];
    assert_eq!(s.sync_connection(id, None).await.unwrap(), 1);
    s.options
        .environment
        .insert("FORGE_CALLS_ENABLED".into(), "false".into());
    assert!(s.sync_connection(id, None).await.is_err());
    s.options.environment.remove("FORGE_CALLS_ENABLED");
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        s.sync_connection(id, None).await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(p.reads.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn summary_leases_publish_recaps_and_actions_once_and_invalid_recaps_retry_atomically() {
    let f = Fixture::new().await;
    let (s, p, _) = setup(&f);
    let team = issue_acceptance::team(&f, 154).await;
    let id = imported(&f, &s, team).await;
    p.hold.store(true, Ordering::SeqCst);
    let service = s.clone();
    let actor = f.actor.clone();
    let task = tokio::spawn(async move { service.summarize_call(id, Some(&actor)).await });
    p.wait().await;
    assert!(!s.summarize_call(id, None).await.unwrap());
    p.release.notify_one();
    assert!(task.await.unwrap().unwrap());
    assert_eq!(
        p.texts.lock().unwrap()[0],
        "Alex: Start small.\nSam: Prepare pilot."
    );
    assert!(!s.summarize_call(id, None).await.unwrap());
    let full = s.read(&f.actor, json!({"callId":id})).await.unwrap();
    assert_eq!(full["summaryStatus"], "ready");
    assert_eq!(full["actions"].as_array().unwrap().len(), 2);
    assert_eq!(p.summaries.load(Ordering::SeqCst), 1);
    let bad = imported(&f, &s, team).await;
    p.hold.store(false, Ordering::SeqCst);
    *p.recap.lock().unwrap() = Some(
        json!({"summary":"Partial","decisions":[],"actions":[{"title":"Good","owner":"Sam"},{"title":"","owner":""}]}),
    );
    assert!(s.summarize_call(bad, None).await.is_err());
    let saved = state(&f, bad).await;
    assert_eq!(saved["summary_status"], "error");
    assert_eq!(saved["summary"], "");
    assert!(saved["summary_lease_at"].is_null());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM call_actions WHERE call_id=$1")
        .bind(bad)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    *p.recap.lock().unwrap() = None;
    assert!(s.summarize_call(bad, None).await.unwrap());
}
#[tokio::test]
async fn summary_rechecks_visibility_and_retention_before_publishing_any_action() {
    for change in ["member", "session", "team", "retention", "clock"] {
        let f = Fixture::new().await;
        let (s, p, clock) = setup(&f);
        let team = issue_acceptance::team(&f, 155).await;
        let id = imported(&f, &s, team).await;
        p.hold.store(true, Ordering::SeqCst);
        let service = s.clone();
        let actor = f.actor.clone();
        let task = tokio::spawn(async move { service.summarize_call(id, Some(&actor)).await });
        p.wait().await;
        match change {
            "member" => {
                sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
                    .bind(&f.actor.workspace_id)
                    .bind(&f.actor.user_id)
                    .execute(&f.pool)
                    .await
                    .unwrap();
            }
            "session" => {
                sqlx::query("DELETE FROM session WHERE token=$1")
                    .bind(&f.token)
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
            "retention" => {
                sqlx::query(
                    "UPDATE calls SET started_at=clock_timestamp()-interval '10 days' WHERE id=$1",
                )
                .bind(id)
                .execute(&f.pool)
                .await
                .unwrap();
                s.save_retention(&f.actor, json!({"days":7})).await.unwrap();
            }
            "clock" => {
                clock.fetch_add(31 * 86400000, Ordering::SeqCst);
            }
            _ => unreachable!(),
        }
        p.release.notify_one();
        assert!(!matches!(task.await.unwrap(), Ok(true)), "{change}");
        let saved = state(&f, id).await;
        assert_eq!(saved["summary"], "");
        assert!(saved["summary_lease_at"].is_null());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM call_actions WHERE call_id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
#[tokio::test]
async fn summary_stale_worker_cannot_release_new_lease_and_transcript_bound_is_checked_before_ai() {
    let f = Fixture::new().await;
    let (s, p, clock) = setup(&f);
    let team = issue_acceptance::team(&f, 156).await;
    let id = imported(&f, &s, team).await;
    p.hold.store(true, Ordering::SeqCst);
    let service = s.clone();
    let first = tokio::spawn(async move { service.summarize_call(id, None).await });
    p.wait().await;
    clock.fetch_add(11 * 60 * 1000, Ordering::SeqCst);
    let newer = Arc::new(Probe::default());
    newer.hold.store(true, Ordering::SeqCst);
    let mut service = s.clone();
    service.summarizer = Some(newer.clone());
    let second = tokio::spawn(async move { service.summarize_call(id, None).await });
    newer.wait().await;
    p.release.notify_one();
    assert!(first.await.unwrap().is_err());
    assert!(!state(&f, id).await["summary_lease_at"].is_null());
    newer.release.notify_one();
    assert!(second.await.unwrap().unwrap());
    let oversized = imported(&f, &s, team).await;
    sqlx::query("UPDATE calls SET transcript=$2 WHERE id=$1")
        .bind(oversized)
        .bind(json!([{"speaker":"Alex","seconds":0,"text":"🙂".repeat(125000)}]))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(s.summarize_call(oversized, None).await.is_err());
    assert_eq!(p.summaries.load(Ordering::SeqCst), 1);
    assert_eq!(state(&f, oversized).await["summary_status"], "error");
}

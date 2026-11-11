use super::{
    Fixture, enter_workspace,
    issue_acceptance::{create, team},
};
use chrono::{Duration, Utc};
use forge_core::{
    actor::ApiScope,
    files::{self, UploadError, upload::Intent},
};
use forge_store::{StoreError, files::UploadStore};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;
fn input(target: Value) -> Value {
    json!({"commandKey":Uuid::new_v4(),"target":target,"name":"file.txt","contentType":"text/plain","sizeBytes":5,"checksum":files::checksum(b"hello")})
}
fn verified(i: &Intent) -> Value {
    json!({"sizeBytes":i.input["sizeBytes"],"checksum":i.input["checksum"],"contentType":i.input["contentType"]})
}
async fn issue(f: &Fixture) -> Value {
    let t = team(f, 1).await;
    let i = create(f, t, "File target").await;
    json!({"kind":"issue","id":i["id"]})
}
async fn count(f: &Fixture, key: &str) -> (i64, i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM resource_files WHERE id=$1),(SELECT count(*) FROM agent_attachments WHERE id=$1),(SELECT count(*) FROM command_receipts WHERE workspace_id=$2 AND operation='files.upload.finalize' AND command_key=$3),(SELECT count(*) FROM command_outbox_events WHERE workspace_id=$2 AND topic='file.ready' AND payload->>'fileId'=$3)").bind(Uuid::parse_str(key).unwrap()).bind(&f.actor.workspace_id).bind(key).fetch_one(&f.pool).await.unwrap()
}
async fn paid(f: &Fixture) {
    sqlx::query("INSERT INTO workspace_entitlements(workspace_id,plan,status,source) VALUES($1,'basic','active','manual') ON CONFLICT(workspace_id) DO UPDATE SET plan='basic',status='active',source='manual'").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
}
#[tokio::test]
async fn upload_reservation_and_publication_retries_commit_one_file_receipt_and_event() {
    let f = Fixture::new().await;
    let store = UploadStore::new(f.database.clone());
    let input = input(issue(&f).await);
    let (a, b) = tokio::join!(
        store.create(&f.actor, input.clone()),
        store.create(&f.actor, input.clone())
    );
    let i = a.unwrap();
    assert_eq!(i.id, b.unwrap().id);
    assert_ne!(i.storage_reference, format!("files/{}", i.id));
    let mut changed = input.clone();
    changed["name"] = json!("other.txt");
    assert!(matches!(
        store.create(&f.actor, changed).await,
        Err(StoreError::Upload(UploadError::Conflict(_)))
    ));
    let wrong = json!({"checksum":"0".repeat(64),"sizeBytes":5,"contentType":"text/plain"});
    assert!(matches!(
        store.publish(&f.actor, &i.id, wrong).await,
        Err(StoreError::Upload(UploadError::Invalid(_)))
    ));
    assert_eq!(count(&f, &i.id).await, (0, 0, 0, 0));
    let (a, b) = tokio::join!(
        store.publish(&f.actor, &i.id, verified(&i)),
        store.publish(&f.actor, &i.id, verified(&i))
    );
    let result = a.unwrap();
    assert_eq!(result, b.unwrap());
    assert_eq!(count(&f, &i.id).await, (1, 0, 1, 1));
    assert_eq!(result["expiresAt"], Value::Null);
    let row: Value = sqlx::query_scalar("SELECT to_jsonb(f) FROM resource_files f WHERE id=$1")
        .bind(Uuid::parse_str(&i.id).unwrap())
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(row["attachment_state"], "unbound");
    assert_eq!(row["storage_reference"], i.storage_reference);
    assert_eq!(
        store.prepare(&f.actor, &i.id, true).await.unwrap().result,
        Some(result)
    );
    store.reject(&f.actor, &i.id, "late cancel").await.unwrap();
    assert_eq!(
        store.prepare(&f.actor, &i.id, false).await.unwrap().state,
        "ready"
    );
    sqlx::query("UPDATE issues SET archived_at=now() WHERE id=$1")
        .bind(Uuid::parse_str(input["target"]["id"].as_str().unwrap()).unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        store.publish(&f.actor, &i.id, verified(&i)).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        store.create(&f.actor, input).await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(count(&f, &i.id).await, (1, 0, 1, 1));
}
#[tokio::test]
async fn upload_account_capacity_is_atomic_and_spans_workspace_sessions() {
    let f = Fixture::new().await;
    let store = UploadStore::new(f.database.clone());
    let target = json!({"kind":"agent"});
    for _ in 0..3 {
        store.create(&f.actor, input(target.clone())).await.unwrap();
    }
    let (a, b) = tokio::join!(
        store.create(&f.actor, input(target.clone())),
        store.create(&f.actor, input(target.clone()))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let full = if let Err(e) = a { e } else { b.err().unwrap() };
    assert!(matches!(
        full,
        StoreError::Upload(UploadError::Limit {
            retry_after_seconds: Some(60),
            ..
        })
    ));
    let other = Fixture::new().await;
    let mut second = enter_workspace(&other, &f).await;
    // The old actor's session now points at the second workspace; capacity is still account-wide.
    assert!(matches!(
        store.create(&second, input(target.clone())).await,
        Err(StoreError::Upload(UploadError::Limit { .. }))
    ));
    second.user_id = other.actor.user_id.clone();
    assert!(matches!(
        store.create(&second, input(target)).await,
        Err(StoreError::Forbidden)
    ));
}
#[tokio::test]
async fn upload_workspace_capacity_counts_all_members_and_never_oversubscribes() {
    let f = Fixture::new().await;
    let store = UploadStore::new(f.database.clone());
    let mut actors = vec![f.actor.clone()];
    for _ in 0..4 {
        let visitor = Fixture::new().await;
        actors.push(enter_workspace(&f, &visitor).await);
    }
    for (n, a) in actors.iter().enumerate().take(4) {
        for _ in 0..if n == 3 { 3 } else { 4 } {
            store
                .create(a, input(json!({"kind":"agent"})))
                .await
                .unwrap();
        }
    }
    let (a, b) = tokio::join!(
        store.create(&actors[3], input(json!({"kind":"agent"}))),
        store.create(&actors[4], input(json!({"kind":"agent"})))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM file_upload_intents WHERE workspace_id=$1 AND state='pending'",
    )
    .bind(&f.actor.workspace_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(n, 16);
}
#[tokio::test]
async fn upload_tokens_have_fixed_expiry_five_attempts_and_ownership() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let mut store = UploadStore::new(f.database.clone());
    let now = chrono::DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    store.now = Arc::new(move || now);
    let i = store
        .create(&f.actor, input(json!({"kind":"agent"})))
        .await
        .unwrap();
    assert!(matches!(
        store.prepare(&member, &i.id, true).await,
        Err(StoreError::Forbidden)
    ));
    store.reject(&member, &i.id, "wrong owner").await.unwrap();
    for _ in 0..5 {
        let t = store.prepare(&f.actor, &i.id, true).await.unwrap();
        assert_eq!(t.expires_at, i.expires_at);
        assert_eq!(t.token_expires_at, Some(now + Duration::minutes(10)));
    }
    assert!(matches!(
        store.prepare(&f.actor, &i.id, true).await,
        Err(StoreError::Upload(UploadError::Limit {
            retry_after_seconds: Some(3600),
            ..
        }))
    ));
    assert!(store.prepare(&f.actor, &i.id, false).await.is_ok());
    store.now = Arc::new(move || now + Duration::hours(1));
    store.prepare(&f.actor, &i.id, true).await.unwrap();
    store.now = Arc::new(move || now + Duration::hours(24) - Duration::seconds(1));
    assert_eq!(
        store
            .prepare(&f.actor, &i.id, true)
            .await
            .unwrap()
            .token_expires_at,
        Some(i.expires_at)
    );
    store.now = Arc::new(move || now + Duration::hours(24));
    assert!(matches!(
        store.prepare(&f.actor, &i.id, false).await,
        Err(StoreError::Upload(UploadError::Invalid(_)))
    ));
}
#[tokio::test]
async fn upload_policy_and_live_membership_are_rechecked_after_reservation() {
    let f = Fixture::new().await;
    let mut store = UploadStore::new(f.database.clone());
    let mut oversized = input(json!({"kind":"agent"}));
    oversized["sizeBytes"] = json!(10_000_001);
    assert!(matches!(
        store.create(&f.actor, oversized.clone()).await,
        Err(StoreError::Upload(UploadError::Invalid(_)))
    ));
    paid(&f).await;
    let large = store.create(&f.actor, oversized).await.unwrap();
    sqlx::query("UPDATE workspace_entitlements SET plan='free' WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        store.publish(&f.actor, &large.id, verified(&large)).await,
        Err(StoreError::Upload(UploadError::Invalid(_)))
    ));
    assert_eq!(count(&f, &large.id).await, (0, 0, 0, 0));
    store.reject(&f.actor, &large.id, "cancel").await.unwrap();
    let i = store
        .create(&f.actor, input(json!({"kind":"agent"})))
        .await
        .unwrap();
    sqlx::query("UPDATE workspace_security_settings SET restrict_file_uploads=true,allowed_upload_types='[]'::jsonb WHERE workspace_id=$1").bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    assert!(matches!(
        store.publish(&f.actor, &i.id, verified(&i)).await,
        Err(StoreError::Upload(UploadError::Invalid(_)))
    ));
    let image = json!({"checksum":i.input["checksum"],"sizeBytes":5,"contentType":"image/png"});
    store.publish(&f.actor, &i.id, image).await.unwrap();
    assert_eq!(count(&f, &i.id).await, (0, 1, 1, 1));
    store.agent_ui = false;
    assert!(matches!(
        store.prepare(&f.actor, &i.id, true).await,
        Err(StoreError::Upload(UploadError::Access(_)))
    ));
    store.agent_ui = true;
    sqlx::query(
        "UPDATE workspace_security_settings SET restrict_file_uploads=false WHERE workspace_id=$1",
    )
    .bind(&f.actor.workspace_id)
    .execute(&f.pool)
    .await
    .unwrap();
    let pending = store
        .create(&f.actor, input(json!({"kind":"agent"})))
        .await
        .unwrap();
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        store.prepare(&f.actor, &pending.id, false).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        store.publish(&f.actor, &i.id, verified(&i)).await,
        Err(StoreError::Forbidden)
    ));
    store
        .reject(&f.actor, &pending.id, "revoked")
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM file_upload_intents WHERE id=$1")
        .bind(Uuid::parse_str(&pending.id).unwrap())
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(state, "rejected");
}
#[tokio::test]
async fn upload_cleanup_waits_out_tokens_revisits_late_bytes_and_retains_orphans() {
    let f = Fixture::new().await;
    let mut store = UploadStore::new(f.database.clone());
    let now = chrono::DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    store.now = Arc::new(move || now);
    let i = store
        .create(&f.actor, input(json!({"kind":"agent"})))
        .await
        .unwrap();
    store.prepare(&f.actor, &i.id, true).await.unwrap();
    store.reject(&f.actor, &i.id, "cancel").await.unwrap();
    assert!(
        !store
            .cleanup_candidates(now, 1000)
            .await
            .unwrap()
            .iter()
            .any(|v| v.id == i.id)
    );
    let later = now + Duration::minutes(25);
    assert!(
        store
            .cleanup_candidates(later, 1000)
            .await
            .unwrap()
            .iter()
            .any(|v| v.id == i.id)
    );
    store.now = Arc::new(move || later);
    store.mark_cleaned(&i.id).await.unwrap();
    assert!(
        !store
            .cleanup_candidates(later, 1000)
            .await
            .unwrap()
            .iter()
            .any(|v| v.id == i.id)
    );
    assert!(
        store
            .cleanup_candidates(later + Duration::hours(1), 1000)
            .await
            .unwrap()
            .iter()
            .any(|v| v.id == i.id)
    );
    store.now = Arc::new(move || now - Duration::hours(25));
    let old = store
        .create(&f.actor, input(json!({"kind":"agent"})))
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization WHERE id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let candidates = store.cleanup_candidates(now, 1000).await.unwrap();
    assert!(
        candidates
            .iter()
            .any(|v| v.id == old.id && v.state == "expired")
    );
    assert!(matches!(
        store.publish(&f.actor, &old.id, verified(&old)).await,
        Err(StoreError::Forbidden)
    ));
}
#[tokio::test]
async fn upload_quota_includes_recent_completions_and_old_pending_bytes_but_releases_rejections() {
    let f = Fixture::new().await;
    paid(&f).await;
    let mut store = UploadStore::new(f.database.clone());
    let now = chrono::DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    store.now = Arc::new(move || now);
    // Seed historical completed reservations without inventing file bytes. The
    // adapter reads these rows as quota inventory, not as publication receipts.
    for n in 0..10 {
        sqlx::query("INSERT INTO file_upload_intents(workspace_id,user_id,command_key,input_hash,target,name,content_type,size_bytes,checksum,storage_reference,state,created_at,expires_at,completed_at,result) VALUES($1,$2,$3,$4,'{\"kind\":\"agent\"}', 'old','text/plain',100000000,$4,$5,'ready',$6,$7,$8,'{}')")
   .bind(&f.actor.workspace_id).bind(&f.actor.user_id).bind(Uuid::new_v4()).bind("a".repeat(64)).bind(format!("files/{}",Uuid::new_v4())).bind(now-Duration::days(2)).bind(now-Duration::days(1)).bind(now-Duration::minutes(n)).execute(&f.pool).await.unwrap();
    }
    assert!(matches!(
        store.create(&f.actor, input(json!({"kind":"agent"}))).await,
        Err(StoreError::Upload(UploadError::Limit {
            retry_after_seconds: Some(3600),
            ..
        }))
    ));
    sqlx::query(
        "UPDATE file_upload_intents SET completed_at=$1 WHERE workspace_id=$2 AND state='ready'",
    )
    .bind(now - Duration::hours(1))
    .bind(&f.actor.workspace_id)
    .execute(&f.pool)
    .await
    .unwrap();
    let pending = store
        .create(&f.actor, input(json!({"kind":"agent"})))
        .await
        .unwrap();
    sqlx::query("UPDATE file_upload_intents SET created_at=$1 WHERE id=$2")
        .bind(now - Duration::hours(2))
        .bind(Uuid::parse_str(&pending.id).unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    // Other accounts' current completions fill the workspace-wide 10GB allowance.
    for _ in 0..100 {
        sqlx::query("INSERT INTO file_upload_intents(workspace_id,user_id,command_key,input_hash,target,name,content_type,size_bytes,checksum,storage_reference,state,created_at,expires_at,completed_at,result) VALUES($1,$2,$3,$4,'{\"kind\":\"agent\"}', 'old','text/plain',100000000,$4,$5,'ready',$6,$7,$6,'{}')")
   .bind(&f.actor.workspace_id).bind(Uuid::new_v4().to_string()).bind(Uuid::new_v4()).bind("a".repeat(64)).bind(format!("files/{}",Uuid::new_v4())).bind(now).bind(now+Duration::days(1)).execute(&f.pool).await.unwrap();
    }
    assert!(matches!(
        store.create(&f.actor, input(json!({"kind":"agent"}))).await,
        Err(StoreError::Upload(UploadError::Limit {
            retry_after_seconds: Some(3600),
            ..
        }))
    ));
    sqlx::query(
        "UPDATE file_upload_intents SET completed_at=$1 WHERE workspace_id=$2 AND state='ready'",
    )
    .bind(now - Duration::hours(1))
    .bind(&f.actor.workspace_id)
    .execute(&f.pool)
    .await
    .unwrap();
    store
        .reject(&f.actor, &pending.id, "release")
        .await
        .unwrap();
    assert!(
        store
            .create(&f.actor, input(json!({"kind":"agent"})))
            .await
            .is_ok()
    );
}
#[tokio::test]
async fn upload_project_document_and_private_issue_targets_keep_current_authority_and_binding_states()
 {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let store = UploadStore::new(f.database.clone());
    let t = team(&f, 1).await;
    let i = create(&f, t, "private").await;
    let p = Uuid::new_v4();
    forge_store::projects::save(
        &f.database,
        &f.actor,
        &Uuid::new_v4().to_string(),
        json!([{"id":p,"expectedRevision":null,"changes":{"name":"P","teamIds":[t]}}]),
    )
    .await
    .unwrap();
    let d = Uuid::new_v4();
    forge_store::documents::command(&f.database,&f.actor,&Uuid::new_v4().to_string(),json!({"action":"create","id":d,"source":{"kind":"issue","id":i["id"]},"fields":{"title":"D","body":{"type":"doc","content":[]},"icon":forge_core::documents::default_icon(),"sectionId":null}}),forge_store::documents::DocumentOptions{enabled:true,team_resources:true}).await.unwrap();
    let mut pending = vec![];
    for (kind, key) in [
        ("issue", i["id"].as_str().unwrap().to_owned()),
        ("project", p.to_string()),
        ("document", d.to_string()),
    ] {
        pending.push(
            store
                .create(&member, input(json!({"kind":kind,"id":key})))
                .await
                .unwrap(),
        );
    }
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(t)
        .execute(&f.pool)
        .await
        .unwrap();
    for v in &pending {
        assert!(matches!(
            store.publish(&member, &v.id, verified(v)).await,
            Err(StoreError::Forbidden)
        ));
        assert_eq!(count(&f, &v.id).await, (0, 0, 0, 0));
    }
    sqlx::query("INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
        .bind(&f.actor.workspace_id)
        .bind(t)
        .bind(&member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    for v in &pending {
        store.publish(&member, &v.id, verified(v)).await.unwrap();
        let state: Option<String> =
            sqlx::query_scalar("SELECT attachment_state FROM resource_files WHERE id=$1")
                .bind(Uuid::parse_str(&v.id).unwrap())
                .fetch_one(&f.pool)
                .await
                .unwrap();
        assert_eq!(
            state.as_deref(),
            if v.input["target"]["kind"] == "document" {
                None
            } else {
                Some("unbound")
            }
        );
    }
    let key = forge_store::api_keys::create(
        &f.database,
        &f.actor,
        &forge_store::api_keys::CreateKey {
            name: "files".into(),
            expires_in_days: 30,
            scopes: vec![ApiScope::IssuesWrite],
        },
    )
    .await
    .unwrap();
    let key_actor =
        forge_store::authority::api_key_actor(&f.database, key["key"].as_str().unwrap())
            .await
            .unwrap();
    assert!(
        store
            .create(&key_actor, input(json!({"kind":"issue","id":i["id"]})))
            .await
            .is_ok()
    );
    for target in [
        json!({"kind":"agent"}),
        json!({"kind":"project","id":p}),
        json!({"kind":"document","id":d}),
    ] {
        assert!(matches!(
            store.create(&key_actor, input(target)).await,
            Err(StoreError::Forbidden)
        ));
    }
    sqlx::query("DELETE FROM team_members WHERE workspace_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    for v in &pending {
        assert!(matches!(
            store.prepare(&member, &v.id, false).await,
            Err(StoreError::Forbidden)
        ));
    }
}
#[tokio::test]
async fn upload_publication_preserves_unavailable_receipts_and_refuses_unsupported_agent_formats() {
    let f = Fixture::new().await;
    let store = UploadStore::new(f.database.clone());
    let i = store
        .create(&f.actor, input(json!({"kind":"agent"})))
        .await
        .unwrap();
    let mut binary = verified(&i);
    binary["contentType"] = json!("application/octet-stream");
    assert!(matches!(
        store.publish(&f.actor, &i.id, binary).await,
        Err(StoreError::Upload(UploadError::Invalid(_)))
    ));
    assert_eq!(count(&f, &i.id).await, (0, 0, 0, 0));
    let result = store.publish(&f.actor, &i.id, verified(&i)).await.unwrap();
    assert!(result["expiresAt"].as_str().is_some());
    sqlx::query("UPDATE command_receipts SET response_body=NULL WHERE workspace_id=$1 AND operation='files.upload.finalize' AND command_key=$2").bind(&f.actor.workspace_id).bind(&i.id).execute(&f.pool).await.unwrap();
    assert!(matches!(
        store.publish(&f.actor, &i.id, verified(&i)).await,
        Err(StoreError::CommandResultUnavailable)
    ));
    assert_eq!(count(&f, &i.id).await, (0, 1, 1, 1));
    let pending = store
        .create(&f.actor, input(json!({"kind":"agent"})))
        .await
        .unwrap();
    let fake = json!({"id":pending.id,"name":"file.txt","contentType":"text/plain","sizeBytes":5,"checksum":pending.input["checksum"],"createdAt":Utc::now().to_rfc3339(),"expiresAt":null});
    sqlx::query("UPDATE file_upload_intents SET state='ready',result=$1 WHERE id=$2")
        .bind(fake)
        .bind(Uuid::parse_str(&pending.id).unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        store
            .publish(&f.actor, &pending.id, verified(&pending))
            .await,
        Err(StoreError::Upload(UploadError::Conflict(_)))
    ));
    assert_eq!(count(&f, &pending.id).await, (0, 0, 0, 0));
}
#[tokio::test]
async fn delivery_requires_current_issue_and_project_attachment_ownership_including_legacy_null_states()
 {
    use forge_store::files::FileLookup;
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let lookup = FileLookup(f.database.clone());
    let store = UploadStore::new(f.database.clone());
    let target = issue(&f).await;
    let i = store.create(&f.actor, input(target.clone())).await.unwrap();
    store.publish(&f.actor, &i.id, verified(&i)).await.unwrap();
    let t = json!({"kind":"resources","id":i.id});
    assert!(lookup.read(&f.actor, &t).await.unwrap().is_none());
    sqlx::query("UPDATE resource_files SET attachment_state=NULL WHERE id=$1")
        .bind(Uuid::parse_str(&i.id).unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(lookup.read(&f.actor, &t).await.unwrap().is_none());
    let comment = Uuid::new_v4();
    sqlx::query("UPDATE resource_files SET attachment_state='attached',comment_id=$2 WHERE id=$1")
        .bind(Uuid::parse_str(&i.id).unwrap())
        .bind(comment)
        .execute(&f.pool)
        .await
        .unwrap();
    let props =
        json!({"comments":[{"id":comment,"text":"posted","attachments":[{"fileId":i.id}]}]});
    sqlx::query("UPDATE issues SET properties=$1 WHERE id=$2")
        .bind(&props)
        .bind(Uuid::parse_str(target["id"].as_str().unwrap()).unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(lookup.read(&member, &t).await.unwrap().is_some());
    for field in ["deleted", "attachments"] {
        let mut hidden = props.clone();
        hidden["comments"][0][field] = if field == "deleted" {
            json!(true)
        } else {
            json!([])
        };
        sqlx::query("UPDATE issues SET properties=$1 WHERE id=$2")
            .bind(hidden)
            .bind(Uuid::parse_str(target["id"].as_str().unwrap()).unwrap())
            .execute(&f.pool)
            .await
            .unwrap();
        assert!(lookup.read(&f.actor, &t).await.unwrap().is_none());
    }
    // An internal legacy file without an intent keeps its pre-upload binding contract.
    let legacy = Uuid::new_v4();
    sqlx::query("INSERT INTO resource_files(id,workspace_id,created_by_user_id,issue_id,name,content_type,size_bytes,checksum,storage_reference) SELECT $1,workspace_id,created_by_user_id,issue_id,name,content_type,size_bytes,checksum,$2 FROM resource_files WHERE id=$3").bind(legacy).bind(format!("files/{}",Uuid::new_v4())).bind(Uuid::parse_str(&i.id).unwrap()).execute(&f.pool).await.unwrap();
    assert!(
        lookup
            .read(&member, &json!({"kind":"resources","id":legacy}))
            .await
            .unwrap()
            .is_some()
    );
    let p = Uuid::new_v4();
    forge_store::projects::save(
        &f.database,
        &f.actor,
        &Uuid::new_v4().to_string(),
        json!([{"id":p,"expectedRevision":null,"changes":{"name":"P","teamIds":[]}}]),
    )
    .await
    .unwrap();
    let project = store
        .create(&f.actor, input(json!({"kind":"project","id":p})))
        .await
        .unwrap();
    store
        .publish(&f.actor, &project.id, verified(&project))
        .await
        .unwrap();
    let target = json!({"kind":"resources","id":project.id});
    assert!(lookup.read(&member, &target).await.unwrap().is_none());
    let post = Uuid::new_v4();
    sqlx::query(
        "UPDATE resource_files SET attachment_state='attached',project_post_id=$2 WHERE id=$1",
    )
    .bind(Uuid::parse_str(&project.id).unwrap())
    .bind(post)
    .execute(&f.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE projects SET properties=$1 WHERE id=$2").bind(json!({"updates":[{"id":Uuid::new_v4(),"comments":[{"id":post,"attachments":[{"fileId":project.id}]}]}]})).bind(p).execute(&f.pool).await.unwrap();
    assert!(lookup.read(&member, &target).await.unwrap().is_some());
    sqlx::query("UPDATE resource_files SET project_post_id=$2 WHERE id=$1")
        .bind(Uuid::parse_str(&project.id).unwrap())
        .bind(Uuid::new_v4())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(lookup.read(&member, &target).await.unwrap().is_none());
}
#[tokio::test]
async fn delivery_attachments_and_artifacts_recheck_owner_expiry_loop_scope_and_triggering_activity()
 {
    use forge_store::files::FileLookup;
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let lookup = FileLookup(f.database.clone());
    let store = UploadStore::new(f.database.clone());
    let i = store
        .create(&f.actor, input(json!({"kind":"agent"})))
        .await
        .unwrap();
    store.publish(&f.actor, &i.id, verified(&i)).await.unwrap();
    let target = json!({"kind":"attachments","id":i.id});
    assert!(lookup.read(&f.actor, &target).await.unwrap().is_some());
    assert!(lookup.read(&member, &target).await.unwrap().is_none());
    sqlx::query("UPDATE agent_attachments SET expires_at=now()-interval '1 minute' WHERE id=$1")
        .bind(Uuid::parse_str(&i.id).unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(lookup.read(&f.actor, &target).await.unwrap().is_none());
    let own = team(&f, 1).await;
    let other = team(&f, 2).await;
    let source = create(&f, other, "Loop source").await;
    let comment = Uuid::new_v4();
    let source_id = Uuid::parse_str(source["id"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE issues SET properties=$1 WHERE id=$2")
        .bind(json!({"comments":[{"id":comment,"text":"Original","attachments":[]}]}))
        .bind(source_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let thread = Uuid::new_v4();
    let run = Uuid::new_v4();
    let artifact = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title) VALUES($1,$2,$3,'Files')").bind(thread).bind(&f.actor.workspace_id).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'completed','forge-native','{}')").bind(run).bind(thread).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO agent_artifacts(id,run_id,kind,name,content_type,size_bytes,storage_reference,checksum,retention_expires_at) VALUES($1,$2,'file','artifact.txt','text/plain',5,$3,$4,now()+interval '1 day')").bind(artifact).bind(run).bind(format!("{run}/{}",Uuid::new_v4())).bind(files::checksum(b"hello")).execute(&f.pool).await.unwrap();
    let target = json!({"kind":"artifacts","id":artifact});
    assert!(lookup.read(&f.actor, &target).await.unwrap().is_some());
    assert!(lookup.read(&member, &target).await.unwrap().is_none());
    let loop_id = Uuid::new_v4();
    let loop_run = Uuid::new_v4();
    let event = json!({"entity":"issue","entityId":source_id,"comment":{"id":comment,"text":"Original","mentionIds":[]}});
    sqlx::query("INSERT INTO team_loops(id,workspace_id,team_id,fields) VALUES($1,$2,$3,$4)")
        .bind(loop_id)
        .bind(&f.actor.workspace_id)
        .bind(own)
        .bind(json!({"teamAccess":"all-public-teams"}))
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO loop_runs(id,workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state,thread_id,agent_run_id) VALUES($1,$2,$3,1,'file-test',$4,$5,$6,$7,'completed',$8,$9)").bind(loop_run).bind(&f.actor.workspace_id).bind(loop_id).bind("a".repeat(64)).bind(&event).bind(json!({"teamAccess":"all-public-teams"})).bind(&f.actor.user_id).bind(thread).bind(run).execute(&f.pool).await.unwrap();
    assert!(lookup.read(&member, &target).await.unwrap().is_some());
    for table in ["team_loops", "loop_runs"] {
        let id = if table == "team_loops" {
            loop_id
        } else {
            loop_run
        };
        let q = format!("UPDATE {table} SET fields=$1 WHERE id=$2");
        sqlx::query(&q)
            .bind(json!({"teamAccess":"own-team"}))
            .bind(id)
            .execute(&f.pool)
            .await
            .unwrap();
        assert!(lookup.read(&f.actor, &target).await.unwrap().is_none());
        sqlx::query(&q)
            .bind(json!({"teamAccess":"all-public-teams"}))
            .bind(id)
            .execute(&f.pool)
            .await
            .unwrap();
    }
    for text in ["Edited", ""] {
        sqlx::query("UPDATE issues SET properties=$1 WHERE id=$2")
            .bind(json!({"comments":[{"id":comment,"text":text}]}))
            .bind(source_id)
            .execute(&f.pool)
            .await
            .unwrap();
        assert!(lookup.read(&member, &target).await.unwrap().is_none());
    }
    sqlx::query("UPDATE issues SET properties=$1 WHERE id=$2")
        .bind(json!({"comments":[{"id":comment,"text":"Original","deleted":true}]}))
        .bind(source_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(lookup.read(&member, &target).await.unwrap().is_none());
}

use super::*;
use forge_core::files::{
    UploadError,
    upload::{Intent, Reader, Transport},
};
use forge_store::issues::{self, purge};
use issue_acceptance::{create, team};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Default)]
struct Blobs {
    fail: AtomicBool,
    deleted: Mutex<Vec<String>>,
}
#[async_trait]
impl Transport for Blobs {
    async fn grant(&self, _: &Intent) -> Result<Value, UploadError> {
        panic!("purge must not issue upload grants")
    }
    async fn read(&self, _: &str) -> Result<Option<Box<dyn Reader>>, UploadError> {
        panic!("purge must not download content")
    }
    async fn delete(&self, reference: &str) -> Result<(), UploadError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(UploadError::Transport);
        }
        self.deleted.lock().unwrap().push(reference.into());
        Ok(())
    }
}
async fn fixture() -> Fixture {
    Fixture::using("FORGE_RUST_RETENTION_TEST_DATABASE_URL").await
}
fn id(v: &Value) -> Uuid {
    v["id"].as_str().unwrap().parse().unwrap()
}
async fn expire(f: &Fixture, id: Uuid) {
    sqlx::query("UPDATE issues SET deleted_at=clock_timestamp()-interval '31 days' WHERE id=$1")
        .bind(id)
        .execute(&f.pool)
        .await
        .unwrap();
}
async fn sweep(f: &Fixture, blobs: &Blobs) -> purge::Counts {
    purge::purge(&f.database, blobs, 25).await.unwrap()
}
async fn done(f: &Fixture, id: Uuid) -> bool {
    sqlx::query_scalar("SELECT purged_at IS NOT NULL FROM issues WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
async fn finish(f: &Fixture, blobs: &Blobs, id: Uuid) {
    for _ in 0..20 {
        if done(f, id).await {
            return;
        }
        let result = sweep(f, blobs).await;
        assert_eq!(result.failed, 0);
    }
    panic!("purge did not complete within bounded test ticks");
}
async fn file(f: &Fixture, issue: Option<Uuid>, doc: Option<Uuid>) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let reference = format!("files/{}", Uuid::new_v4());
    sqlx::query("INSERT INTO resource_files(id,workspace_id,created_by_user_id,issue_id,document_id,name,content_type,size_bytes,checksum,storage_reference) VALUES($1,$2,$3,$4,$5,'private.txt','text/plain',1,$6,$7)").bind(id).bind(&f.actor.workspace_id).bind(&f.actor.user_id).bind(issue).bind(doc).bind("b".repeat(64)).bind(&reference).execute(&f.pool).await.unwrap();
    (id, reference)
}

#[tokio::test]
async fn issue_purge_retries_bytes_keeps_shared_documents_and_cannot_restore_expired_content() {
    let _guard = SERIAL.lock().await;
    let f = fixture().await;
    let team = team(&f, 1).await;
    let issue = create(&f, team, "Private purge body").await;
    let target = id(&issue);
    let child = id(&create(&f, team, "Survivor").await);
    sqlx::query("UPDATE issues SET parent_id=$1 WHERE id=$2")
        .bind(target)
        .bind(child)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) VALUES($1,$2,$3,'related')").bind(&f.actor.workspace_id).bind(target).bind(child).execute(&f.pool).await.unwrap();
    let private = Uuid::new_v4();
    let shared = Uuid::new_v4();
    sqlx::query("INSERT INTO documents(id,workspace_id,title,issue_id,shared_with_workspace,body) VALUES($1,$3,'Private',$4,false,'{}'),($2,$3,'Shared',$4,true,'{}')").bind(private).bind(shared).bind(&f.actor.workspace_id).bind(target).execute(&f.pool).await.unwrap();
    let (file_id, reference) = file(&f, None, Some(private)).await;
    let (shared_file, shared_reference) = file(&f, None, Some(shared)).await;
    let key = format!("forge:inbox:v1:{}", Uuid::new_v4());
    let body = json!({"entries":[{"id":format!("issue:{target}"),"issue":{"id":target,"title":"Private purge body"}},{"id":format!("issue:{child}"),"issue":{"id":child,"title":"Survivor"}}]});
    sqlx::query("INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)").bind(&f.actor.workspace_id).bind(format!("user:{}",f.actor.user_id)).bind(&f.actor.user_id).bind(&key).bind(json!(body.to_string()).to_string()).execute(&f.pool).await.unwrap();
    let intent=forge_store::files::UploadStore::new(f.database.clone()).create(&f.actor,json!({"commandKey":Uuid::new_v4(),"target":{"kind":"issue","id":target},"name":"unpublished.txt","contentType":"text/plain","sizeBytes":1,"checksum":"b".repeat(64)})).await.unwrap();
    expire(&f, target).await;
    let blobs = Blobs::default();
    blobs.fail.store(true, Ordering::SeqCst);
    sqlx::query("INSERT INTO operational_job_health(key,completed_at) VALUES('issues.retention','1900-01-01') ON CONFLICT(key) DO UPDATE SET completed_at=EXCLUDED.completed_at").execute(&f.pool).await.unwrap();
    assert_eq!(purge::run(&f.database, &blobs).await.unwrap().failed, 1);
    let health:(bool,bool)=sqlx::query_as("SELECT completed_at='1900-01-01'::timestamptz,failed_at IS NOT NULL FROM operational_job_health WHERE key='issues.retention'").fetch_one(&f.pool).await.unwrap();
    assert_eq!(health, (true, true));
    let stalled:(bool,bool,String)=sqlx::query_as("SELECT purge_started_at IS NOT NULL,purged_at IS NOT NULL,purge_error FROM issues WHERE id=$1").bind(target).fetch_one(&f.pool).await.unwrap();
    assert_eq!(
        stalled,
        (true, false, "Issue purge failed; retry pending.".into())
    );
    let revision: i32 = sqlx::query_scalar("SELECT revision FROM issues WHERE id=$1")
        .bind(target)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let rejected=issues::lifecycle(&f.database,&f.actor,json!({"teamId":team,"issueId":target,"commandKey":Uuid::new_v4(),"expectedRevision":revision,"action":"restore"})).await.unwrap_err();
    assert_eq!(rejected.to_string(), "The issue recovery period has ended.");
    let remains: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM resource_files WHERE id=$1)")
            .bind(file_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(remains);
    blobs.fail.store(false, Ordering::SeqCst);
    sqlx::query("UPDATE issues SET purge_lease_until=NULL WHERE id=$1")
        .bind(target)
        .execute(&f.pool)
        .await
        .unwrap();
    finish(&f, &blobs, target).await;
    let row: (String, Value, Option<Uuid>, Option<String>) =
        sqlx::query_as("SELECT title,properties,parent_id,creator_id FROM issues WHERE id=$1")
            .bind(target)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(row, (String::new(), json!({}), None, None));
    let survivors:(i64,i64,Option<Uuid>,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM documents WHERE id=$1),(SELECT count(*) FROM resource_files WHERE id=$2),(SELECT parent_id FROM issues WHERE id=$3),(SELECT count(*) FROM issue_relations WHERE issue_id=$4 OR related_issue_id=$4)").bind(shared).bind(shared_file).bind(child).bind(target).fetch_one(&f.pool).await.unwrap();
    assert_eq!(survivors, (1, 1, None, 0));
    let value: String = sqlx::query_scalar(
        "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
    )
    .bind(&f.actor.workspace_id)
    .bind(key)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(!value.contains("Private purge body"));
    assert!(value.contains("Survivor"));
    {
        let deleted = blobs.deleted.lock().unwrap();
        assert!(deleted.contains(&reference));
        assert!(deleted.contains(&intent.storage_reference));
        assert!(!deleted.contains(&shared_reference));
    }
    assert_eq!(sweep(&f, &blobs).await.purged, 0);
    assert_eq!(purge::run(&f.database, &blobs).await.unwrap().failed, 0);
    let fresh:bool=sqlx::query_scalar("SELECT completed_at>'1900-01-01'::timestamptz FROM operational_job_health WHERE key='issues.retention'").fetch_one(&f.pool).await.unwrap();
    assert!(fresh);
}

#[tokio::test]
async fn issue_purge_checkpoints_many_files_copies_and_history_without_erasing_receipts() {
    let _guard = SERIAL.lock().await;
    let f = fixture().await;
    let team = team(&f, 1).await;
    let issue = create(&f, team, "Large purge").await;
    let target = id(&issue);
    let survivor = id(&create(&f, team, "Visible").await);
    for _ in 0..101 {
        file(&f, Some(target), None).await;
    }
    for n in 0..12 {
        let value = if n == 0 {
            format!("malformed {target}")
        } else if n == 1 {
            "malformed unrelated".into()
        } else {
            json!(json!({"commandKey":Uuid::new_v4(),"edits":[{"issueId":target,"title":"erase"},{"issueId":survivor,"title":"keep"}]}).to_string()).to_string()
        };
        sqlx::query("INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)").bind(&f.actor.workspace_id).bind(format!("user:{}",f.actor.user_id)).bind(&f.actor.user_id).bind(format!("forge:team-issue-edit-drafts:v1:{n}")).bind(value).execute(&f.pool).await.unwrap();
    }
    let receipt: Uuid = sqlx::query_scalar(
        "SELECT id FROM command_receipts WHERE workspace_id=$1 ORDER BY created_at LIMIT 1",
    )
    .bind(&f.actor.workspace_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO command_outbox_events(workspace_id,command_id,ordinal,topic,payload) SELECT $1,$2,n,'issue.updated',jsonb_build_object('issueId',$3::uuid::text,'private','snapshot') FROM generate_series(1,101)n").bind(&f.actor.workspace_id).bind(receipt).bind(target).execute(&f.pool).await.unwrap();
    expire(&f, target).await;
    let blobs = Blobs::default();
    let first = sweep(&f, &blobs).await;
    assert_eq!((first.purged, first.failed), (0, 0));
    assert_eq!(blobs.deleted.lock().unwrap().len(), 100);
    assert!(!done(&f, target).await);
    let second = sweep(&f, &blobs).await;
    assert_eq!(second.failed, 0);
    assert!(!done(&f, target).await);
    let cursor: Option<Uuid> =
        sqlx::query_scalar("SELECT purge_copy_cursor FROM issues WHERE id=$1")
            .bind(target)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(cursor.is_some());
    finish(&f, &blobs, target).await;
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT key,encoded_value FROM product_state WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_all(&f.pool)
            .await
            .unwrap();
    for (key, value) in rows {
        if key.ends_with(":0") {
            assert!(value.is_none());
        } else if key.ends_with(":1") {
            assert_eq!(value.as_deref(), Some("malformed unrelated"));
        } else if key.starts_with("forge:team-issue-edit-drafts") {
            let value = value.unwrap();
            assert!(!value.contains(&target.to_string()));
            assert!(value.contains(&survivor.to_string()));
            assert!(value.contains("requiresReview"));
        }
    }
    let evidence:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND payload->>'issueId'=$2::uuid::text),(SELECT count(*) FROM command_receipts WHERE id=$3),(SELECT count(*) FROM command_audit_events WHERE command_id=$3)").bind(&f.actor.workspace_id).bind(target).bind(receipt).fetch_one(&f.pool).await.unwrap();
    assert_eq!(evidence, (0, 1, 1));
}

#[tokio::test]
async fn issue_purge_drains_loop_payloads_and_waits_for_reserved_uploads() {
    let _guard = SERIAL.lock().await;
    let f = fixture().await;
    let team = team(&f, 1).await;
    let target = id(&create(&f, team, "Loop source").await);
    let thread = Uuid::new_v4();
    let run = Uuid::new_v4();
    let loop_id = Uuid::new_v4();
    let loop_run = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title) VALUES($1,$2,$3,'Purge')").bind(thread).bind(&f.actor.workspace_id).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'running','forge-native','{}')").bind(run).bind(thread).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO team_loops(id,workspace_id,team_id,fields,enabled,enabled_by_id,enabled_at) VALUES($1,$2,$3,'{}',true,$4,clock_timestamp())").bind(loop_id).bind(&f.actor.workspace_id).bind(team).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO loop_runs(id,workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state,thread_id,agent_run_id,result,pending_decision) VALUES($1,$2,$3,1,'purge',$4,$5,'{}',$6,'running',$7,$8,'private result','{}')").bind(loop_run).bind(&f.actor.workspace_id).bind(loop_id).bind("a".repeat(64)).bind(json!({"entity":"issue","entityId":target,"private":"snapshot"})).bind(&f.actor.user_id).bind(thread).bind(run).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO agent_events(thread_id,run_id,source,source_event_id,sequence,type,payload_json,occurred_at) SELECT $1,$2,'forge',n::text,n,'text','{\"private\":true}',clock_timestamp() FROM generate_series(1,101)n").bind(thread).bind(run).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO agent_approvals(workspace_id,run_id,requested_for_user_id,capability_id,risk,input_hash,redacted_input_summary,state,nonce,expires_at) VALUES($1,$2,$3,'fixture','read',$4,'{\"private\":true}','approved',$5,clock_timestamp()+interval '1 day')").bind(&f.actor.workspace_id).bind(run).bind(&f.actor.user_id).bind("a".repeat(64)).bind(Uuid::new_v4().to_string()).execute(&f.pool).await.unwrap();
    let artifact_ref = format!("{run}/{}", Uuid::new_v4());
    sqlx::query("INSERT INTO agent_artifacts(run_id,kind,name,content_type,size_bytes,storage_reference,checksum) VALUES($1,'file','private.txt','text/plain',1,$2,$3)").bind(run).bind(&artifact_ref).bind("a".repeat(64)).execute(&f.pool).await.unwrap();
    let reservation = Uuid::new_v4();
    let ref_pending = format!("{run}/{}", Uuid::new_v4());
    sqlx::query("INSERT INTO loop_artifact_intents(id,workspace_id,loop_run_id,agent_run_id,storage_reference,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '20 minutes'+interval '2 seconds')").bind(reservation).bind(&f.actor.workspace_id).bind(loop_run).bind(run).bind(&ref_pending).execute(&f.pool).await.unwrap();
    expire(&f, target).await;
    let blobs = Blobs::default();
    assert_eq!(sweep(&f, &blobs).await.failed, 0);
    assert!(!done(&f, target).await);
    let row: (String, Option<String>, Value, Option<String>, Option<Value>) = sqlx::query_as(
        "SELECT state,error_code,event,result,pending_decision FROM loop_runs WHERE id=$1",
    )
    .bind(loop_run)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "cancelled".into(),
            Some("SOURCE_PURGED".into()),
            json!({"entity":"issue","entityId":target}),
            None,
            None
        )
    );
    assert!(!blobs.deleted.lock().unwrap().contains(&ref_pending));
    sqlx::query("UPDATE agent_runs SET state='running',error_code=NULL WHERE id=$1")
        .bind(run)
        .execute(&f.pool)
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM agent_runs WHERE id=$1")
        .bind(run)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(state, "cancelled");
    tokio::time::sleep(std::time::Duration::from_millis(2250)).await;
    finish(&f, &blobs, target).await;
    let copies:(i64,i64,i64,String,Value)=sqlx::query_as("SELECT (SELECT count(*) FROM agent_events WHERE run_id=$1 AND payload_json<>'{}'),(SELECT count(*) FROM agent_artifacts WHERE run_id=$1),(SELECT count(*) FROM loop_artifact_intents WHERE agent_run_id=$1),(SELECT state FROM agent_approvals WHERE run_id=$1),(SELECT redacted_input_summary FROM agent_approvals WHERE run_id=$1)").bind(run).fetch_one(&f.pool).await.unwrap();
    assert_eq!(copies, (0, 0, 0, "expired".into(), json!({})));
    assert!(blobs.deleted.lock().unwrap().contains(&artifact_ref));
    assert!(blobs.deleted.lock().unwrap().contains(&ref_pending));
}

#[tokio::test]
async fn competing_issue_purges_have_one_owner_and_do_not_touch_recoverable_issues() {
    let _guard = SERIAL.lock().await;
    let f = fixture().await;
    let team = team(&f, 1).await;
    let target = id(&create(&f, team, "Expired").await);
    let recoverable = id(&create(&f, team, "Recoverable").await);
    expire(&f, target).await;
    sqlx::query("UPDATE issues SET deleted_at=clock_timestamp()-interval '29 days' WHERE id=$1")
        .bind(recoverable)
        .execute(&f.pool)
        .await
        .unwrap();
    let blobs = Blobs::default();
    let (a, b) = tokio::join!(
        purge::purge(&f.database, &blobs, 1),
        purge::purge(&f.database, &blobs, 1)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.purged + b.purged, 1);
    assert_eq!(a.failed + b.failed, 0);
    assert!(!done(&f, recoverable).await);
    let attempts: i32 = sqlx::query_scalar("SELECT purge_attempts FROM issues WHERE id=$1")
        .bind(target)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(attempts, 1);
    for limit in [0, 101, -1] {
        assert!(matches!(
            purge::purge(&f.database, &blobs, limit).await,
            Err(StoreError::InvalidInput)
        ));
    }
}

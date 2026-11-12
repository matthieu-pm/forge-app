use async_trait::async_trait;
use forge_core::journal::{
    DeletionJournalBackend, EventBatches, JournalError, JournalSource, RecoveryEvent,
};
use forge_store::{Database, StoreError, accounts};
use futures_util::StreamExt;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU8, Ordering},
};
use uuid::Uuid;

#[path = "support/agent_blobs.rs"]
mod agent_blobs;

#[path = "acceptance/agent_file_recovery.rs"]
mod agent_file_recovery;
#[path = "acceptance/agent_recovery.rs"]
mod agent_recovery;
#[path = "acceptance/coordinator_recovery.rs"]
mod coordinator_recovery;
#[path = "acceptance/invitation_recovery.rs"]
mod invitation_recovery;
#[path = "acceptance/loop_recovery.rs"]
mod loop_recovery;
#[path = "acceptance/model_recovery.rs"]
mod model_recovery;
#[path = "acceptance/template_recovery.rs"]
mod template_recovery;

#[derive(Default)]
struct CaptureJournal {
    mode: AtomicU8,
    prepared: Mutex<Vec<String>>,
    completed: Mutex<Vec<(String, Vec<RecoveryEvent>)>>,
    aborted: Mutex<Vec<String>>,
    settled: tokio::sync::Notify,
}

#[async_trait]
impl DeletionJournalBackend for CaptureJournal {
    async fn prepare(&self, operation: &str, source: &JournalSource) -> Result<(), JournalError> {
        assert_eq!(source.branch_id, "br-local-recovery");
        if self.mode.load(Ordering::Relaxed) == 1 {
            return Err(JournalError::Unavailable);
        }
        self.prepared.lock().unwrap().push(operation.into());
        Ok(())
    }
    async fn complete(
        &self,
        operation: &str,
        _source: &JournalSource,
        mut batches: EventBatches,
    ) -> Result<(), JournalError> {
        let mut events = Vec::new();
        while let Some(batch) = batches.next().await {
            events.extend(batch?);
        }
        if self.mode.load(Ordering::Relaxed) == 2 {
            return Err(JournalError::Unavailable);
        }
        self.completed
            .lock()
            .unwrap()
            .push((operation.into(), events));
        self.settled.notify_one();
        Ok(())
    }
    async fn abort(&self, operation: &str, _source: &JournalSource) -> Result<(), JournalError> {
        self.aborted.lock().unwrap().push(operation.into());
        self.settled.notify_one();
        Ok(())
    }
}

struct Fixture {
    pool: PgPool,
    database: Database,
    backend: Arc<CaptureJournal>,
    token: String,
    user_id: String,
}

#[tokio::test]
async fn issue_purge_prepares_before_bytes_and_records_deletion_and_storage_evidence() {
    use forge_core::{
        files::{
            UploadError,
            upload::{Intent, Reader, Transport},
        },
        issues::CreateIssue,
    };
    use forge_store::issues::{self, IssueOptions, purge};
    use serde_json::{Value, json};
    struct Blobs(std::sync::atomic::AtomicUsize);
    #[async_trait]
    impl Transport for Blobs {
        async fn grant(&self, _: &Intent) -> Result<Value, UploadError> {
            unreachable!()
        }
        async fn read(&self, _: &str) -> Result<Option<Box<dyn Reader>>, UploadError> {
            unreachable!()
        }
        async fn delete(&self, _: &str) -> Result<(), UploadError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Purge recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Purge recovery","identifier":"PRG","icon":{"kind":"emoji","value":"🛠️","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let mut draft = forge_core::issues::blank("todo");
    draft["title"] = json!("Retained private title");
    let issue = issues::create(
        &f.database,
        &actor,
        &CreateIssue::parse(json!({"teamId":team.id,"commandKey":Uuid::new_v4(),"draft":draft}))
            .unwrap(),
        IssueOptions::default(),
    )
    .await
    .unwrap();
    let id: Uuid = issue["issue"]["id"].as_str().unwrap().parse().unwrap();
    let doc = Uuid::new_v4();
    let reference = format!("files/{}", Uuid::new_v4());
    let mut tx = f.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    sqlx::query("INSERT INTO documents(id,workspace_id,title,issue_id,body) VALUES($1,$2,'Private',$3,'{}')").bind(doc).bind(&actor.workspace_id).bind(id).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO resource_files(workspace_id,created_by_user_id,document_id,name,content_type,size_bytes,checksum,storage_reference) VALUES($1,$2,$3,'private.txt','text/plain',1,$4,$5)").bind(&actor.workspace_id).bind(&actor.user_id).bind(doc).bind("a".repeat(64)).bind(&reference).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE issues SET deleted_at=clock_timestamp()-interval '31 days' WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let blobs = Blobs(std::sync::atomic::AtomicUsize::new(0));
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(purge::purge(&f.database, &blobs, 25).await.is_err());
    assert_eq!(blobs.0.load(Ordering::SeqCst), 0);
    f.backend.mode.store(0, Ordering::Relaxed);
    assert_eq!(
        purge::purge(&f.database, &blobs, 25).await.unwrap().purged,
        1
    );
    assert_eq!(blobs.0.load(Ordering::SeqCst), 1);
    let scrubbed: (String, Value, bool) =
        sqlx::query_as("SELECT title,properties,purged_at IS NOT NULL FROM issues WHERE id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(scrubbed, (String::new(), json!({}), true));
    let completed = f.backend.completed.lock().unwrap();
    for table in ["resource_files", "documents"] {
        assert!(completed.iter().any(|(_, events)| {
            events.iter().any(|e| {
                e.table == table && e.action == forge_core::journal::RecoveryAction::Delete
            })
        }));
    }
    assert!(completed.iter().any(|(_, events)| events.iter().any(|e| {
        e.table == "resource_files" && e.storage_reference.as_deref() == Some(reference.as_str())
    })));
}

#[tokio::test]
async fn workflow_retention_prepares_recovery_and_archives_deleted_rows() {
    use forge_store::jobs::{self, Enqueue, JobStore, runner};
    use serde_json::json;
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Job recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let mut tx = f.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    sqlx::query("INSERT INTO business_workflow_runs(id,workspace_id,kind,subject_type,subject_id,idempotency_key,state,completed_at) VALUES($1,$2,'fixture','fixture',$1::text,$1::text,'completed','1900-01-01')").bind(id).bind(&actor.workspace_id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let store = JobStore::new(f.database.clone());
    let kind = format!("retention:{}", Uuid::new_v4());
    let job = store
        .enqueue(&Enqueue {
            kind: kind.clone(),
            scope: actor.workspace_id,
            identity: Uuid::new_v4().to_string(),
            input: json!({"cutoff":"1901-01-01T00:00:00.000Z"}),
            scheduled_at: "2020-01-01T00:00:00Z".parse().unwrap(),
            max_attempts: 5,
        })
        .await
        .unwrap();
    let lease = store.claim(&kind, Some(job)).await.unwrap().unwrap();
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        runner::Handler::run(&jobs::retention::WorkflowRetention, &store, &lease)
            .await
            .is_err()
    );
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM business_workflow_runs WHERE id=$1)")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(exists);
    f.backend.mode.store(0, Ordering::Relaxed);
    runner::Handler::run(&jobs::retention::WorkflowRetention, &store, &lease)
        .await
        .unwrap();
    store.complete(&lease).await.unwrap();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM business_workflow_runs WHERE id=$1)")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(!exists);
    assert!(
        f.backend
            .completed
            .lock()
            .unwrap()
            .iter()
            .any(
                |(_, events)| events.iter().any(|e| e.table == "business_workflow_runs"
                    && e.action == forge_core::journal::RecoveryAction::Delete)
            )
    );
}

#[tokio::test]
async fn saved_view_deletion_and_favorite_removal_share_recovery_preparation() {
    use forge_store::saved_views::{self, ViewOptions};
    use serde_json::json;
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Recovery views",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let options = ViewOptions { enabled: true };
    let id = Uuid::new_v4();
    let definition = json!({"version":1,"name":"Retained view","description":"","icon":null,"visibility":"workspace","kind":"issues","filters":{"match":"all","rules":[]},"display":forge_core::issue_query::default_display()});
    saved_views::mutate(
        &f.database,
        &actor,
        &Uuid::new_v4().to_string(),
        json!({"action":"save","id":id,"expectedRevision":null,"definition":definition}),
        options,
    )
    .await
    .unwrap();
    saved_views::mutate(
        &f.database,
        &actor,
        &Uuid::new_v4().to_string(),
        json!({"action":"favorite","id":id,"favorite":true}),
        options,
    )
    .await
    .unwrap();
    let key = Uuid::new_v4().to_string();
    let delete = json!({"action":"delete","id":id,"expectedRevision":1});
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        saved_views::mutate(&f.database, &actor, &key, delete.clone(), options)
            .await
            .is_err()
    );
    assert_eq!(
        saved_views::read(&f.database, &actor, options)
            .await
            .unwrap()["views"][0]["favorite"],
        true
    );
    f.backend.mode.store(0, Ordering::Relaxed);
    saved_views::mutate(&f.database, &actor, &key, delete, options)
        .await
        .unwrap();
    assert_eq!(
        saved_views::read(&f.database, &actor, options)
            .await
            .unwrap()["views"],
        json!([])
    );
    assert!(
        f.backend
            .completed
            .lock()
            .unwrap()
            .iter()
            .any(|(_, events)| events.iter().any(|e| e.table == "saved_views"
                && e.patch
                    .as_ref()
                    .is_some_and(|p| p.get("deleted_at").is_some_and(|v| !v.is_null()))))
    );
}

#[tokio::test]
async fn document_tombstone_and_history_wait_for_recovery_preparation() {
    use forge_store::documents::{self, DocumentOptions};
    use serde_json::json;
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Recovery documents",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let options = DocumentOptions {
        enabled: true,
        team_resources: false,
    };
    let id = Uuid::new_v4();
    documents::command(&f.database,&actor,&Uuid::new_v4().to_string(),json!({"action":"create","id":id,"source":{"kind":"workspace"},"fields":{"title":"Retained writing","body":forge_core::documents::empty_body(),"icon":forge_core::documents::default_icon()}}),options).await.unwrap();
    let key = Uuid::new_v4().to_string();
    let input = json!({"action":"delete","id":id,"expectedRevision":1});
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        documents::command(&f.database, &actor, &key, input.clone(), options)
            .await
            .is_err()
    );
    assert_eq!(
        documents::read(&f.database, &actor, None, Some(id), options)
            .await
            .unwrap()[0]["revision"],
        1
    );
    let history: i64 =
        sqlx::query_scalar("SELECT count(*) FROM document_revisions WHERE document_id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(history, 1);
    f.backend.mode.store(0, Ordering::Relaxed);
    assert_eq!(
        documents::command(&f.database, &actor, &key, input, options)
            .await
            .unwrap()["revision"],
        2
    );
    assert!(
        documents::read(&f.database, &actor, None, Some(id), options)
            .await
            .is_err()
    );
    assert!(
        f.backend
            .completed
            .lock()
            .unwrap()
            .iter()
            .any(|(_, events)| events.iter().any(|e| e.table == "documents"
                && e.patch
                    .as_ref()
                    .is_some_and(|p| p.get("deleted_at").is_some_and(|v| !v.is_null()))))
    );
}

#[tokio::test]
async fn canonical_issue_effects_and_history_roll_back_when_preparation_fails() {
    use forge_core::issues::{CreateIssue, EditIssues};
    use forge_store::issues::{self, IssueOptions};
    use serde_json::json;
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Recovery issues",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Recovery issues","identifier":"RISS","icon":{"kind":"emoji","value":"🛠️","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let mut draft = forge_core::issues::blank("todo");
    draft["title"] = json!("Recoverable issue");
    let input =
        CreateIssue::parse(json!({"teamId":team.id,"commandKey":Uuid::new_v4(),"draft":draft}))
            .unwrap();
    let completed_before = f.backend.completed.lock().unwrap().len();
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        issues::create(&f.database, &actor, &input, IssueOptions::default())
            .await
            .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM issues WHERE workspace_id=$1")
            .bind(&actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic LIKE 'issue.%'").bind(&actor.workspace_id).fetch_one(&f.pool).await.unwrap(),0);
    f.backend.mode.store(0, Ordering::Relaxed);
    let created = issues::create(&f.database, &actor, &input, IssueOptions::default())
        .await
        .unwrap();
    let edit=EditIssues::parse(json!({"teamId":team.id,"commandKey":Uuid::new_v4(),"edits":[{"issueId":created["issue"]["id"],"expectedRevision":0,"changes":{"title":"Updated recovery issue","status":"in-progress"}}]})).unwrap();
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        issues::edit(&f.database, &actor, &edit, IssueOptions::default())
            .await
            .is_err()
    );
    let after_failure = issues::read(&f.database, &actor, false).await.unwrap();
    assert_eq!(
        after_failure["records"][0]["issue"]["title"],
        "Recoverable issue"
    );
    assert_eq!(after_failure["records"][0]["issue"]["revision"], 0);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic LIKE 'issue.%'").bind(&actor.workspace_id).fetch_one(&f.pool).await.unwrap(),1);
    f.backend.mode.store(0, Ordering::Relaxed);
    let saved = issues::edit(&f.database, &actor, &edit, IssueOptions::default())
        .await
        .unwrap();
    assert_eq!(saved["records"][0]["issue"]["revision"], 1);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic LIKE 'issue.%'").bind(&actor.workspace_id).fetch_one(&f.pool).await.unwrap(),2);
    // The source journal captures destructive/security patches. Issue title,
    // status_id, and history inserts are deliberately outside its patch set;
    // these commands still require preparation and completed publication.
    {
        let completed = f.backend.completed.lock().unwrap();
        assert_eq!(completed.len(), completed_before + 2);
        for (operation, events) in &completed[completed_before..] {
            assert!(f.backend.prepared.lock().unwrap().contains(operation));
            assert!(events.is_empty());
        }
    }
    let archive = json!({"teamId":team.id,"issueId":created["issue"]["id"],"commandKey":Uuid::new_v4(),"expectedRevision":1,"action":"archive"});
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        issues::lifecycle(&f.database, &actor, archive.clone())
            .await
            .is_err()
    );
    assert_eq!(
        issues::read(&f.database, &actor, false).await.unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.backend.mode.store(0, Ordering::Relaxed);
    assert_eq!(
        issues::lifecycle(&f.database, &actor, archive)
            .await
            .unwrap()["value"]["active"],
        false
    );
    assert!(
        f.backend
            .completed
            .lock()
            .unwrap()
            .iter()
            .any(|(_, events)| events.iter().any(|e| e.table == "issues"
                && e.patch
                    .as_ref()
                    .is_some_and(|p| p.get("archived_at").is_some_and(|v| !v.is_null()))))
    );
}

#[tokio::test]
async fn project_relation_removal_requires_preparation_and_publishes_recovery_rows() {
    use forge_store::projects;
    use serde_json::json;
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Recovery projects",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let a = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&a,&forge_core::teams::CreateTeam::parse(json!({"name":"Project team","identifier":"RPJ","icon":{"kind":"emoji","value":"🛠️","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let id = Uuid::new_v4();
    projects::save(&f.database,&a,&Uuid::new_v4().to_string(),json!([{"id":id,"expectedRevision":null,"changes":{"name":"Recovery project","teamIds":[team.id]}}])).await.unwrap();
    let row = projects::read(&f.database, &a).await.unwrap()["projects"][0].clone();
    let key = Uuid::new_v4().to_string();
    let changes = json!([{"id":id,"expectedRevision":row["revision"],"changes":{"teamIds":[]}}]);
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        projects::save(&f.database, &a, &key, changes.clone())
            .await
            .is_err()
    );
    assert_eq!(
        projects::read(&f.database, &a).await.unwrap()["projects"][0]["teamIds"],
        json!([team.id])
    );
    f.backend.mode.store(0, Ordering::Relaxed);
    projects::save(&f.database, &a, &key, changes)
        .await
        .unwrap();
    assert!(
        f.backend
            .completed
            .lock()
            .unwrap()
            .iter()
            .any(|(_, events)| events.iter().any(|e| e.table == "project_teams"))
    );
    use forge_store::initiatives::{self, InitiativeOptions};
    let options = InitiativeOptions { enabled: true };
    let initiative = Uuid::new_v4();
    initiatives::save(&f.database,&a,&Uuid::new_v4().to_string(),json!([{"id":initiative,"expectedRevision":null,"changes":{"name":"Recovery initiative"},"addProjectIds":[id]}]),options).await.unwrap();
    let snapshot = initiatives::read(&f.database, &a, options).await.unwrap();
    let changes = json!([{"id":initiative,"expectedRevision":snapshot["initiatives"][0]["revision"],"changes":{},"removeProjectIds":[id]}]);
    let key = Uuid::new_v4().to_string();
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        initiatives::save(&f.database, &a, &key, changes.clone(), options)
            .await
            .is_err()
    );
    assert_eq!(
        initiatives::read(&f.database, &a, options).await.unwrap()["initiatives"][0]["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.backend.mode.store(0, Ordering::Relaxed);
    initiatives::save(&f.database, &a, &key, changes, options)
        .await
        .unwrap();
    assert!(
        f.backend
            .completed
            .lock()
            .unwrap()
            .iter()
            .any(|(_, events)| events.iter().any(|e| e.table == "initiative_projects"))
    );
}

#[tokio::test]
async fn definition_deletion_requires_independent_preparation_and_publishes_removed_rows() {
    use forge_store::definitions::{self, DefinitionCommand};
    use serde_json::json;
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Recovery definitions",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Recovery definitions","identifier":"RDEF","icon":{"kind":"emoji","value":"🛠️","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let snapshot = definitions::read(&f.database, &actor, Some(team.id))
        .await
        .unwrap();
    let mut value = snapshot.value.into_value();
    value["statuses"]["statuses"].as_array_mut().unwrap().push(
        json!({"id":"ready","name":"Ready","group":"unstarted","description":"","color":"#abcdef"}),
    );
    let forge_core::actor::Authentication::Session { session_id } = &actor.authentication else {
        panic!("session")
    };
    let mut input:DefinitionCommand=serde_json::from_value(json!({"workspaceId":actor.workspace_id,"sessionId":session_id,"teamId":team.id,"commandKey":Uuid::new_v4().to_string(),"expectedRevision":0,"value":value})).unwrap();
    definitions::save(&f.database, &actor, &input)
        .await
        .unwrap();
    value["statuses"]["statuses"]
        .as_array_mut()
        .unwrap()
        .retain(|s| s["id"] != "ready");
    input.value = forge_core::definitions::DefinitionValue::parse(value).unwrap();
    input.expected_revision = 1;
    input.command_key = Uuid::new_v4().to_string();
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        definitions::save(&f.database, &actor, &input)
            .await
            .is_err()
    );
    assert!(
        definitions::read(&f.database, &actor, Some(team.id))
            .await
            .unwrap()
            .value
            .statuses()
            .iter()
            .any(|s| s["id"] == "ready")
    );
    f.backend.mode.store(0, Ordering::Relaxed);
    assert_eq!(
        definitions::save(&f.database, &actor, &input)
            .await
            .unwrap()
            .revision,
        2
    );
    assert!(
        f.backend
            .completed
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, events)| events)
            .any(|e| e.table == "issue_statuses"
                && e.action == forge_core::journal::RecoveryAction::Delete
                && e.key.get("row_id").is_some_and(|v| v.is_string()))
    );
}

impl Fixture {
    async fn new() -> Self {
        let connection = std::env::var("FORGE_RUST_JOURNAL_TEST_DATABASE_URL")
            .expect("Run bun run rewrite:verify");
        let options: sqlx::postgres::PgConnectOptions = connection.parse().unwrap();
        assert_eq!(options.get_host(), "127.0.0.1");
        assert_eq!(options.get_database(), Some("forge_rust_journal"));
        assert_eq!(options.get_username(), "forge_rust_test");
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SELECT set_config('neon.branch_id','br-local-recovery',false)")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .unwrap();
        let backend = Arc::new(CaptureJournal::default());
        let database =
            Database::with_journal(pool.clone(), backend.clone(), "store_localtest".into());
        let user_id = Uuid::new_v4().to_string();
        let token = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO \"user\"(id,name,email,email_verified) VALUES($1,'Test account',$2,true)",
        )
        .bind(&user_id)
        .bind(format!("{user_id}@example.test"))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO session(id,token,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')").bind(Uuid::new_v4().to_string()).bind(&token).bind(&user_id).execute(&pool).await.unwrap();
        Self {
            pool,
            database,
            backend,
            token,
            user_id,
        }
    }
    async fn session_exists(&self) -> bool {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session WHERE token=$1)")
            .bind(&self.token)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn security_defaults_and_mutations_are_independently_journaled() {
    let f = Fixture::new().await;
    let workspace = forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Recovery policy",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let secret = "test-workspace-invite-secret-only-1234";
    let snapshot =
        forge_store::security::snapshot(&f.database, &actor, "http://localhost:3100", secret)
            .await
            .unwrap();
    assert_eq!(snapshot["version"], 1);
    assert!(
        f.backend
            .completed
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, events)| events)
            .any(|e| e.table == "workspace_security_settings")
    );
    // A missing independent backend must reject before changing security state.
    struct NoDns;
    #[async_trait]
    impl forge_store::security::TxtResolver for NoDns {
        async fn records(&self, _domain: &str) -> Result<Vec<String>, StoreError> {
            panic!("No DNS required")
        }
    }
    let command =
        serde_json::from_value(serde_json::json!({"type":"reset-invite-link","expectedVersion":1}))
            .unwrap();
    let missing = Database::new(f.pool.clone());
    assert!(
        forge_store::security::execute(
            &missing,
            &actor,
            &command,
            &NoDns,
            "http://localhost:3100",
            secret
        )
        .await
        .is_err()
    );
    let version: i32 =
        sqlx::query_scalar("SELECT version FROM workspace_security_settings WHERE workspace_id=$1")
            .bind(&workspace.id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(version, 1);
    let changed = forge_store::security::execute(
        &f.database,
        &actor,
        &command,
        &NoDns,
        "http://localhost:3100",
        secret,
    )
    .await
    .unwrap();
    assert_eq!(changed["version"], 2);
    assert_ne!(snapshot["inviteLink"], changed["inviteLink"]);
}

#[tokio::test]
async fn team_lifecycle_prepares_before_archiving_and_records_restoration() {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Recovery teams",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let input=forge_core::teams::CreateTeam::parse(serde_json::json!({"name":"Recoverable team","identifier":"RCVR","icon":{"kind":"emoji","value":"🛠️","color":"#818cf8"},"timezone":"UTC"})).unwrap();
    let team = forge_store::teams::create(&f.database, &actor, &input)
        .await
        .unwrap();
    let selector = forge_store::teams::Selector::Id(team.id);
    f.backend.mode.store(1, Ordering::Relaxed);
    assert!(
        forge_store::teams::archive(&f.database, &actor, &selector, None)
            .await
            .is_err()
    );
    assert!(
        forge_store::teams::get(&f.database, &actor, &selector)
            .await
            .unwrap()
            .is_some()
    );
    f.backend.mode.store(0, Ordering::Relaxed);
    forge_store::teams::archive(&f.database, &actor, &selector, None)
        .await
        .unwrap();
    assert!(
        forge_store::teams::get(&f.database, &actor, &selector)
            .await
            .unwrap()
            .is_none()
    );
    forge_store::teams::restore(&f.database, &actor, &selector)
        .await
        .unwrap();
    let completed = f.backend.completed.lock().unwrap();
    let events: Vec<_> = completed
        .iter()
        .flat_map(|(_, events)| events)
        .filter(|event| event.table == "teams")
        .collect();
    assert!(events.iter().any(|event| {
        event
            .patch
            .as_ref()
            .is_some_and(|p| p.get("deleted_at").is_some_and(|v| !v.is_null()))
    }));
    assert!(events.iter().any(|event| {
        event
            .patch
            .as_ref()
            .is_some_and(|p| p.get("deleted_at").is_some_and(serde_json::Value::is_null))
    }));
}

#[tokio::test]
async fn independent_prepare_and_complete_surround_a_committed_deletion() {
    let fixture = Fixture::new().await;
    accounts::sign_out(&fixture.database, &fixture.token)
        .await
        .unwrap();
    assert!(!fixture.session_exists().await);
    let prepared = fixture.backend.prepared.lock().unwrap().clone();
    assert_eq!(prepared.len(), 1);
    let completed = fixture.backend.completed.lock().unwrap().clone();
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].0, prepared[0]);
    assert_eq!(completed[0].1.len(), 1);
    let event = &completed[0].1[0];
    assert_eq!(event.table, "session");
    assert!(event.patch.is_none());
    assert!(
        !serde_json::to_string(event)
            .unwrap()
            .contains(&fixture.token)
    );
    let published: bool =
        sqlx::query_scalar("SELECT published_at IS NOT NULL FROM recovery_operations WHERE id=$1")
            .bind(Uuid::parse_str(&prepared[0]).unwrap())
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert!(published);
    assert!(fixture.backend.aborted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_prepare_prevents_the_sql_effect() {
    let fixture = Fixture::new().await;
    fixture.backend.mode.store(1, Ordering::Relaxed);
    assert!(matches!(
        accounts::sign_out(&fixture.database, &fixture.token).await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    assert!(fixture.session_exists().await);
    assert!(fixture.backend.completed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_publication_leaves_the_committed_operation_pending_not_aborted() {
    let fixture = Fixture::new().await;
    fixture.backend.mode.store(2, Ordering::Relaxed);
    assert!(matches!(
        accounts::sign_out(&fixture.database, &fixture.token).await,
        Err(StoreError::Recovery(JournalError::PublicationPending))
    ));
    assert!(!fixture.session_exists().await);
    let prepared = fixture.backend.prepared.lock().unwrap().clone();
    assert_eq!(prepared.len(), 1);
    let unpublished: bool =
        sqlx::query_scalar("SELECT published_at IS NULL FROM recovery_operations WHERE id=$1")
            .bind(Uuid::parse_str(&prepared[0]).unwrap())
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert!(unpublished);
    assert!(fixture.backend.aborted.lock().unwrap().is_empty());
    assert!(fixture.backend.completed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn explicit_rollback_publishes_an_abort_and_restores_the_row() {
    let fixture = Fixture::new().await;
    let mut tx = fixture.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(&fixture.token)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert!(fixture.session_exists().await);
    assert_eq!(fixture.backend.aborted.lock().unwrap().len(), 1);
    assert!(fixture.backend.completed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dropped_transactions_abort_only_after_database_rollback() {
    let fixture = Fixture::new().await;
    {
        let mut tx = fixture.database.begin().await.unwrap();
        tx.prepare().await.unwrap();
        sqlx::query("DELETE FROM session WHERE token=$1")
            .bind(&fixture.token)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fixture.backend.settled.notified(),
    )
    .await
    .unwrap();
    assert!(fixture.session_exists().await);
    assert_eq!(fixture.backend.aborted.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn enabled_capture_requires_a_configured_independent_backend() {
    let fixture = Fixture::new().await;
    let unconfigured = Database::new(fixture.pool.clone());
    assert!(matches!(
        accounts::sign_out(&unconfigured, &fixture.token).await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    assert!(fixture.session_exists().await);
}

#[tokio::test]
async fn verification_updates_are_captured_without_journaling_credentials() {
    let fixture = Fixture::new().await;
    let mut tx = fixture.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    sqlx::query("UPDATE \"user\" SET email_verified=false WHERE id=$1")
        .bind(&fixture.user_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let completed = fixture.backend.completed.lock().unwrap().clone();
    let events = &completed[0].1;
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].patch.as_ref().unwrap().get("email_verified"),
        Some(&serde_json::json!(false))
    );
}

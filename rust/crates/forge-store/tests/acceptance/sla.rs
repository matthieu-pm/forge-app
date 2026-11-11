use super::{
    Fixture, enter_workspace,
    issue_acceptance::{create_input, team},
};
use forge_core::{
    actor::{Actor, Authentication},
    issues::CreateIssue,
    sla as contract,
};
use forge_store::{
    StoreError,
    issues::{self, IssueOptions},
    jobs::{JobStore, runner},
    sla,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use uuid::Uuid;
struct SlaFixture {
    f: Fixture,
    team: Uuid,
    rule: Value,
    enabled: Arc<AtomicBool>,
    deployment: Arc<AtomicUsize>,
}
impl SlaFixture {
    async fn new() -> Self {
        let mut f = Fixture::new().await;
        let enabled = Arc::new(AtomicBool::new(true));
        let deployment = Arc::new(AtomicUsize::new(1));
        let on = enabled.clone();
        let version = deployment.clone();
        f.database = f.database.clone().with_sla_gate(Arc::new(move |workspace| {
            let on = on.load(Ordering::SeqCst);
            (
                on,
                contract::gate_identity(
                    &format!("fixture-{}", version.load(Ordering::SeqCst)),
                    workspace,
                    on,
                ),
            )
        }));
        let team = team(&f, 1).await;
        let rule = json!({"id":Uuid::new_v4(),"enabled":true,"action":"apply","filters":{"priorities":["Urgent"]},"duration":{"unit":"hour","value":1},"startMode":"ruleMatch"});
        let s = Self {
            f,
            team,
            rule,
            enabled,
            deployment,
        };
        assert_eq!(
            sla::save(&s.f.database, &s.f.actor, s.command(0, true))
                .await
                .unwrap()["status"],
            "saved"
        );
        s
    }
    fn command(&self, revision: i32, enabled: bool) -> Value {
        let mut v = identity(&self.f.actor);
        v["commandKey"] = json!(Uuid::new_v4());
        v["expectedRevision"] = json!(revision);
        v["values"] = json!({"enabled":enabled,"workWeek":"mon-fri","rules":[self.rule]});
        v
    }
    async fn pending(&self) -> Value {
        sla::read(&self.f.database, &self.f.actor, identity(&self.f.actor))
            .await
            .unwrap()
    }
    async fn commitment(&self, future: bool) -> (Uuid, Uuid) {
        let issue = Uuid::new_v4();
        let id = Uuid::new_v4();
        let rule: Uuid = self.rule["id"].as_str().unwrap().parse().unwrap();
        let mut draft = forge_core::issues::blank("todo");
        draft["priority"] = json!("Urgent");
        draft["title"] = json!("Worker fixture");
        sqlx::query("INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,properties) VALUES($1,$2,$3,10000,'Worker fixture','todo',$4)").bind(issue).bind(&self.f.actor.workspace_id).bind(self.team).bind(draft).execute(&self.f.pool).await.unwrap();
        let gate = contract::gate_identity(
            &format!("fixture-{}", self.deployment.load(Ordering::SeqCst)),
            &self.f.actor.workspace_id,
            self.enabled.load(Ordering::SeqCst),
        );
        sqlx::query("INSERT INTO issue_slas(id,workspace_id,issue_id,generation,rule_id,policy_revision,snapshot,anchor_at,deadline_at,high_risk_at,moderate_risk_at,gate_identity) VALUES($1,$2,$3,1,$4,1,$5,clock_timestamp()-interval '2 hours',clock_timestamp()+$6::interval,clock_timestamp()-interval '25 hours',clock_timestamp()-interval '8 days',$7)").bind(id).bind(&self.f.actor.workspace_id).bind(issue).bind(rule).bind(json!({"rule":self.rule,"timezone":"Europe/Paris","workWeek":"mon-fri"})).bind(if future{"1 hour"}else{"-1 hour"}).bind(gate).execute(&self.f.pool).await.unwrap();
        sqlx::query("INSERT INTO issue_sla_windows(commitment_id) VALUES($1)")
            .bind(id)
            .execute(&self.f.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO issue_sla_intents(commitment_id) VALUES($1)")
            .bind(id)
            .execute(&self.f.pool)
            .await
            .unwrap();
        (issue, id)
    }
    async fn run(&self, id: Uuid) -> (Uuid, Value) {
        let store = JobStore::new(self.f.database.clone());
        sla::dispatch(&self.f.database, &store).await.unwrap();
        let job: Uuid =
            sqlx::query_scalar("SELECT job_id FROM issue_sla_intents WHERE commitment_id=$1")
                .bind(id)
                .fetch_one(&self.f.pool)
                .await
                .unwrap();
        sqlx::query("UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1").bind(job).execute(&self.f.pool).await.unwrap();
        let result = runner::run_next(&store, sla::KIND, &sla::BreachJob, Some(job))
            .await
            .unwrap();
        (job, result)
    }
    async fn breaches(&self, issue: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM issue_sla_events WHERE issue_id=$1 AND kind='breached'",
        )
        .bind(issue)
        .fetch_one(&self.f.pool)
        .await
        .unwrap()
    }
}
fn identity(a: &Actor) -> Value {
    let Authentication::Session { session_id } = &a.authentication else {
        panic!()
    };
    json!({"workspaceId":a.workspace_id,"sessionId":session_id})
}

#[tokio::test]
async fn policy_replay_conflicts_and_live_admin_authority() {
    let s = SlaFixture::new().await;
    let input = s.command(1, true);
    let (a, b) = tokio::join!(
        sla::save(&s.f.database, &s.f.actor, input.clone()),
        sla::save(&s.f.database, &s.f.actor, input.clone())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a["snapshot"]["revision"], 2);
    assert_eq!(b["snapshot"]["revision"], 2);
    assert_ne!(a["replayed"], b["replayed"]);
    assert_eq!(
        sla::save(&s.f.database, &s.f.actor, s.command(1, true))
            .await
            .unwrap()["status"],
        "conflict"
    );
    let visitor = Fixture::new().await;
    let member = enter_workspace(&s.f, &visitor).await;
    assert!(matches!(
        sla::read(&s.f.database, &member, identity(&member)).await,
        Err(StoreError::Forbidden)
    ));
    let mut wrong = identity(&s.f.actor);
    wrong["sessionId"] = json!("other");
    assert!(matches!(
        sla::read(&s.f.database, &s.f.actor, wrong).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&s.f.actor.workspace_id)
        .bind(&s.f.actor.user_id)
        .execute(&s.f.pool)
        .await
        .unwrap();
    assert!(matches!(
        sla::save(&s.f.database, &s.f.actor, input).await,
        Err(StoreError::Forbidden)
    ));
    let events:i64=sqlx::query_scalar("SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic='sla.policy.updated'").bind(&s.f.actor.workspace_id).fetch_one(&s.f.pool).await.unwrap();
    assert_eq!(events, 2);
}
#[tokio::test]
async fn policy_rejects_foreign_and_missing_references_without_advancing_revision() {
    let s = SlaFixture::new().await;
    let other = Fixture::new().await;
    let foreign = team(&other, 1).await;
    for filters in [
        json!({"teamIds":[foreign]}),
        json!({"teamIds":[s.team],"statuses":[{"teamId":foreign,"statusId":"todo"}]}),
        json!({"statuses":[{"teamId":s.team,"statusId":"missing"}]}),
    ] {
        let mut input = s.command(1, true);
        input["values"]["rules"][0]["filters"] = filters;
        let result = sla::save(&s.f.database, &s.f.actor, input).await.unwrap();
        assert_eq!(result["status"], "invalid");
        assert_eq!(result["snapshot"]["revision"], 1);
    }
    let mut input = s.command(1, true);
    input["values"]["rules"][0]["filters"] =
        json!({"teamIds":[s.team,s.team],"statuses":[{"teamId":s.team,"statusId":"todo"}]});
    assert_eq!(
        sla::save(&s.f.database, &s.f.actor, input).await.unwrap()["status"],
        "saved"
    );
}
#[tokio::test]
async fn canonical_member_creation_preserves_deadline_intent_and_system_history_atomically() {
    let s = SlaFixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&s.f, &visitor).await;
    let mut input = create_input(s.team, "Urgent issue");
    input["draft"]["priority"] = json!("Urgent");
    input["draft"]["dueDate"] = json!("2027-02-01");
    let input = CreateIssue::parse(input).unwrap();
    let first = issues::create(&s.f.database, &member, &input, IssueOptions::default())
        .await
        .unwrap();
    let replay = issues::create(&s.f.database, &member, &input, IssueOptions::default())
        .await
        .unwrap();
    assert_eq!(replay["replayed"], true);
    let id: Uuid = first["issue"]["id"].as_str().unwrap().parse().unwrap();
    let observed:(i64,i64,i64)=sqlx::query_as("SELECT (extract(epoch from (g.deadline_at-g.anchor_at))*1000)::bigint,(SELECT count(*) FROM issue_sla_intents WHERE commitment_id=g.id),(SELECT count(*) FROM issue_slas WHERE issue_id=$1) FROM issue_slas g WHERE issue_id=$1").bind(id).fetch_one(&s.f.pool).await.unwrap();
    assert_eq!(observed, (3_600_000, 1, 1));
    let history = issues::history(&s.f.database, &member, json!({"issueId":id}))
        .await
        .unwrap();
    assert!(
        history["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["topic"] == "issue.sla.applied" && e["actor"]["kind"] == "system")
    );
    let before = first["issue"].clone();
    assert!(!before["sla"].is_null());
    s.enabled.store(false, Ordering::SeqCst);
    let history = issues::history(&s.f.database, &member, json!({"issueId":id}))
        .await
        .unwrap();
    assert!(
        history["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["topic"] != "issue.sla.applied")
    );
}
#[tokio::test]
async fn breach_dispatch_and_worker_are_idempotent_and_future_work_defers_without_consuming_attempts()
 {
    for future in [false, true] {
        let s = SlaFixture::new().await;
        let (issue, id) = s.commitment(future).await;
        let (job, result) = s.run(id).await;
        assert_eq!(
            result["state"],
            if future { "deferred" } else { "completed" }
        );
        assert_eq!(s.breaches(issue).await, if future { 0 } else { 1 });
        let (_, again) = s.run(id).await;
        assert_eq!(again["state"], if future { "deferred" } else { "idle" });
        assert_eq!(s.breaches(issue).await, if future { 0 } else { 1 });
        let attempts: i32 = sqlx::query_scalar("SELECT attempts FROM background_jobs WHERE id=$1")
            .bind(job)
            .fetch_one(&s.f.pool)
            .await
            .unwrap();
        assert_eq!(attempts, if future { 0 } else { 1 });
        let checkpoints: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM background_job_steps WHERE job_id=$1 AND key='breach'",
        )
        .bind(job)
        .fetch_one(&s.f.pool)
        .await
        .unwrap();
        assert_eq!(checkpoints, if future { 0 } else { 1 });
    }
}
#[tokio::test]
async fn interrupted_availability_requires_current_evidence_and_reconciliation_replays_once() {
    let s = SlaFixture::new().await;
    let (issue, id) = s.commitment(false).await;
    s.enabled.store(false, Ordering::SeqCst);
    assert_eq!(s.run(id).await.1["state"], "deferred");
    assert_eq!(s.breaches(issue).await, 0);
    assert!(matches!(
        sla::read(&s.f.database, &s.f.actor, identity(&s.f.actor)).await,
        Err(StoreError::Forbidden)
    ));
    s.enabled.store(true, Ordering::SeqCst);
    let pending = s.pending().await;
    let entry = pending["reconciliation"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == id.to_string())
        .unwrap();
    let mut input = identity(&s.f.actor);
    input["commandKey"] = json!(Uuid::new_v4());
    input["commitmentId"] = json!(id);
    input["expectedVersion"] = entry["version"].clone();
    input["decision"] = json!("breach-owed");
    input["evidence"] = json!("Verified fixture release interval");
    s.deployment.fetch_add(1, Ordering::SeqCst);
    assert!(matches!(
        sla::reconcile(&s.f.database, &s.f.actor, input.clone()).await,
        Err(StoreError::SlaReconciliationConflict)
    ));
    let pending = s.pending().await;
    input["expectedVersion"] = pending["reconciliation"][0]["version"].clone();
    let result = sla::reconcile(&s.f.database, &s.f.actor, input.clone())
        .await
        .unwrap();
    assert_eq!(result["replayed"], false);
    assert_eq!(
        sla::reconcile(&s.f.database, &s.f.actor, input)
            .await
            .unwrap()["replayed"],
        true
    );
    assert_eq!(s.run(id).await.1["state"], "completed");
    assert_eq!(s.breaches(issue).await, 1);
    assert!(
        s.pending().await["reconciliation"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn business_day_calendar_keeps_wall_time_across_dst_and_work_week_boundaries() {
    let f = Fixture::new().await;
    for (anchor, count, unit, week, zone, expected) in [
        (
            "2027-03-26T08:00:00Z",
            1,
            "business-day",
            "mon-fri",
            "Europe/Paris",
            "2027-03-29T07:00:00Z",
        ),
        (
            "2027-03-26T08:00:00Z",
            24,
            "hour",
            "mon-fri",
            "Europe/Paris",
            "2027-03-27T08:00:00Z",
        ),
        (
            "2027-10-29T07:00:00Z",
            1,
            "business-day",
            "mon-fri",
            "Europe/Paris",
            "2027-11-01T08:00:00Z",
        ),
        (
            "2027-11-04T14:00:00Z",
            1,
            "business-day",
            "sun-thu",
            "UTC",
            "2027-11-07T14:00:00Z",
        ),
    ] {
        let value: chrono::DateTime<chrono::Utc> =
            sqlx::query_scalar("SELECT forge_sla_shift($1::text::timestamptz,$2::int,$3,$4,$5)")
                .bind(anchor)
                .bind(count)
                .bind(unit)
                .bind(week)
                .bind(zone)
                .fetch_one(&f.pool)
                .await
                .unwrap();
        assert_eq!(
            value,
            expected.parse::<chrono::DateTime<chrono::Utc>>().unwrap()
        );
    }
}

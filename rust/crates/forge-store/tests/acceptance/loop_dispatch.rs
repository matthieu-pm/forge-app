use super::{Fixture, issue_acceptance, loop_acceptance};
use chrono::{DateTime, Duration, Utc};
use forge_store::{
    loops::{ExpiredRuns, Service},
    projects,
};
use serde_json::{Value, json};
use uuid::Uuid;

async fn definition(f: &Fixture, s: &Service, team: Uuid, trigger: Value, all: bool) -> Uuid {
    let mut fields = loop_acceptance::fields();
    fields["trigger"] = trigger;
    if all {
        fields["teamAccess"] = json!("all-public-teams");
    }
    let id = loop_acceptance::create(s, &f.actor, team, fields).await;
    loop_acceptance::enable(s, &f.actor, team, id, 1).await;
    id
}
async fn count(f: &Fixture, id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM loop_runs WHERE loop_id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
fn at(s: &str) -> DateTime<Utc> {
    s.parse().unwrap()
}

#[tokio::test]
async fn native_scanners_deduplicate_project_audiences_and_capture_final_links_once() {
    let f = Fixture::new().await;
    let s = loop_acceptance::service(&f);
    let a = issue_acceptance::team(&f, 91).await;
    let b = issue_acceptance::team(&f, 92).await;
    let id = definition(
        &f,
        &s,
        a,
        json!({"kind":"event","entity":"project","event":"created"}),
        true,
    )
    .await;
    let project = Uuid::new_v4();
    projects::save(&f.database, &f.actor, &Uuid::new_v4().to_string(), json!([{"id":project,"expectedRevision":null,"changes":{"name":"Shared final membership","teamIds":[a,b]}}])).await.unwrap();
    let events: Vec<Value> =
        sqlx::query_scalar("SELECT after FROM loop_events WHERE workspace_id=$1 ORDER BY id")
            .bind(&f.actor.workspace_id)
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert_eq!(events.len(), 2);
    assert!(
        events
            .iter()
            .all(|e| e["teamIds"].as_array().unwrap().len() == 2)
    );
    let (first, second) = tokio::join!(
        s.enqueue_native(100, Some(&f.actor.workspace_id)),
        s.enqueue_native(100, Some(&f.actor.workspace_id))
    );
    assert_eq!(first.unwrap() + second.unwrap(), 2);
    assert_eq!(count(&f, id).await, 1);
    let (revision, event, fields): (i32, Value, Value) =
        sqlx::query_as("SELECT loop_revision,event,fields FROM loop_runs WHERE loop_id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(revision, 2);
    assert_eq!(event["entityId"], project.to_string());
    assert_eq!(event["context"]["team"].as_array().unwrap().len(), 2);
    assert_eq!(fields["teamAccess"], "all-public-teams");
    assert_eq!(
        s.enqueue_native(100, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn native_scans_respect_private_sources_enable_time_workspace_and_feature_gate() {
    let f = Fixture::new().await;
    let mut s = loop_acceptance::service(&f);
    let public = issue_acceptance::team(&f, 93).await;
    let private = issue_acceptance::team(&f, 94).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(private)
        .execute(&f.pool)
        .await
        .unwrap();
    let trigger = json!({"kind":"event","entity":"issue","event":"created"});
    let broad = definition(&f, &s, public, trigger.clone(), true).await;
    let own = definition(&f, &s, private, trigger.clone(), false).await;
    issue_acceptance::create(&f, private, "Private source").await;
    let issue = issue_acceptance::create(&f, public, "Before late enable").await;
    let late = definition(&f, &s, public, trigger, true).await;
    sqlx::query("UPDATE team_loops SET enabled_at=(SELECT max(created_at)+interval '1 millisecond' FROM loop_events WHERE workspace_id=$2) WHERE id=$1").bind(late).bind(&f.actor.workspace_id).execute(&f.pool).await.unwrap();
    s.options.enabled = false;
    assert_eq!(
        s.enqueue_native(100, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        0
    );
    s.options.enabled = true;
    assert_eq!(
        s.enqueue_native(100, Some("other-workspace"))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        s.enqueue_native(0, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        s.enqueue_native(100, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        2
    );
    assert_eq!(count(&f, broad).await, 1);
    assert_eq!(count(&f, own).await, 1);
    assert_eq!(count(&f, late).await, 0);
    let event: Value = sqlx::query_scalar("SELECT event FROM loop_runs WHERE loop_id=$1")
        .bind(broad)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(event["entityId"], issue["id"]);
    // An event whose source team is now archived is acknowledged without work.
    issue_acceptance::create(&f, private, "Archived before scan").await;
    sqlx::query("UPDATE teams SET deleted_at=clock_timestamp() WHERE id=$1")
        .bind(private)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        s.enqueue_native(100, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        2
    );
    assert_eq!(count(&f, own).await, 1);
}

#[tokio::test]
async fn disable_waits_for_native_capture_and_cancels_its_committed_run() {
    let f = Fixture::new().await;
    let s = loop_acceptance::service(&f);
    let team = issue_acceptance::team(&f, 100).await;
    let id = definition(
        &f,
        &s,
        team,
        json!({"kind":"event","entity":"issue","event":"created"}),
        false,
    )
    .await;
    issue_acceptance::create(&f, team, "Concurrent capture").await;
    // Block precisely this loop's insert, after the scanner has locked its
    // definition. Unrelated fixture work remains free to insert other runs.
    let name = format!("loop_barrier_{}", Uuid::new_v4().simple());
    let key = i64::from(Uuid::new_v4().as_fields().0 & 0x7fff_ffff);
    sqlx::query(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.loop_id='{id}'::uuid THEN PERFORM pg_advisory_xact_lock({key}::bigint); END IF; RETURN NEW; END; $$")).execute(&f.pool).await.unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER {name} BEFORE INSERT ON loop_runs FOR EACH ROW EXECUTE FUNCTION {name}()"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    let mut blocker = f.pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(key)
        .execute(&mut *blocker)
        .await
        .unwrap();
    let race = async {
        let mut native_pid = None;
        for _ in 0..200 {
            native_pid=sqlx::query_scalar::<_,i32>("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid::bigint=$1 AND NOT granted LIMIT 1").bind(key).fetch_optional(&f.pool).await.unwrap();
            if native_pid.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let release = async {
            let mut waiting = false;
            if let Some(pid) = native_pid {
                for _ in 0..200 {
                    waiting=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))").bind(pid).fetch_one(&f.pool).await.unwrap();
                    if waiting {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            }
            blocker.rollback().await.unwrap();
            waiting
        };
        let team_id = team.to_string();
        let command_key = Uuid::new_v4().to_string();
        let (disabled, waiting) = tokio::join!(
            s.command(
                &f.actor,
                &team_id,
                &command_key,
                json!({"action":"disable","id":id,"expectedRevision":2})
            ),
            release
        );
        (native_pid, disabled, waiting)
    };
    let (enqueued, (pid, disabled, waiting)) =
        tokio::join!(s.enqueue_native(1, Some(&f.actor.workspace_id)), race);
    sqlx::query(&format!("DROP TRIGGER {name} ON loop_runs"))
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query(&format!("DROP FUNCTION {name}()"))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        pid.is_some() && waiting,
        "disable must wait for the scanner's definition lock"
    );
    assert_eq!(enqueued.unwrap(), 1);
    assert_eq!(disabled.unwrap()["revision"], 3);
    loop_acceptance::enable(&s, &f.actor, team, id, 3).await;
    let states: Vec<String> = sqlx::query_scalar("SELECT state FROM loop_runs WHERE loop_id=$1")
        .bind(id)
        .fetch_all(&f.pool)
        .await
        .unwrap();
    assert_eq!(states, vec!["cancelled"]);
    assert_eq!(
        s.enqueue_native(100, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn native_changes_ignore_metadata_and_activity_edits_and_keep_rollback_atomic() {
    let f = Fixture::new().await;
    let s = loop_acceptance::service(&f);
    let team = issue_acceptance::team(&f, 95).await;
    let project = Uuid::new_v4();
    projects::save(&f.database, &f.actor, &Uuid::new_v4().to_string(), json!([{"id":project,"expectedRevision":null,"changes":{"name":"Project","teamIds":[team]}}])).await.unwrap();
    let updated = definition(
        &f,
        &s,
        team,
        json!({"kind":"event","entity":"project","event":"updated"}),
        false,
    )
    .await;
    let commented = definition(
        &f,
        &s,
        team,
        json!({"kind":"event","entity":"project","event":"comment","commentMode":"any"}),
        false,
    )
    .await;
    let comment = json!({"id":Uuid::new_v4(),"body":"New comment"});
    sqlx::query("UPDATE projects SET properties=properties||$2 WHERE id=$1").bind(project).bind(json!({"comments":[comment],"reactions":{"like":[f.actor.user_id]},"updatedAt":"2030-03-31T00:00:00Z"})).execute(&f.pool).await.unwrap();
    assert_eq!(
        s.enqueue_native(100, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        1
    );
    assert_eq!(count(&f, updated).await, 0);
    assert_eq!(count(&f, commented).await, 1);
    sqlx::query("UPDATE projects SET properties=jsonb_set(properties,'{comments,0,body}','\"Edited comment\"') WHERE id=$1").bind(project).execute(&f.pool).await.unwrap();
    s.enqueue_native(100, Some(&f.actor.workspace_id))
        .await
        .unwrap();
    assert_eq!(count(&f, commented).await, 1);
    let mut tx = f.pool.begin().await.unwrap();
    sqlx::query("UPDATE projects SET name='Rolled back' WHERE id=$1")
        .bind(project)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(
        s.enqueue_native(100, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        0
    );
    sqlx::query("UPDATE projects SET name='Real change' WHERE id=$1")
        .bind(project)
        .execute(&f.pool)
        .await
        .unwrap();
    s.enqueue_native(100, Some(&f.actor.workspace_id))
        .await
        .unwrap();
    assert_eq!(count(&f, updated).await, 1);
    assert_eq!(count(&f, commented).await, 1);
}

#[tokio::test]
async fn schedules_coalesce_missed_ticks_and_skip_locked_definitions_without_duplicate_runs() {
    let f = Fixture::new().await;
    let mut s = loop_acceptance::service(&f);
    let team = issue_acceptance::team(&f, 96).await;
    s.now = std::sync::Arc::new(|| at("2030-03-28T12:00:00Z"));
    let start = at("2030-03-28T12:01:00Z");
    let now = start + Duration::hours(10);
    let id = definition(&f, &s, team, json!({"kind":"schedule","unit":"hours","interval":1,"startAt":"2030-03-28T12:01:00Z","timeZone":"Europe/Paris"}), false).await;
    let mut lock = f.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM team_loops WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    assert_eq!(
        s.enqueue_scheduled(now, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        0
    );
    lock.rollback().await.unwrap();
    let (a, b) = tokio::join!(
        s.enqueue_scheduled(now, Some(&f.actor.workspace_id)),
        s.enqueue_scheduled(now, Some(&f.actor.workspace_id))
    );
    assert_eq!(a.unwrap() + b.unwrap(), 1);
    let (key, event): (String, Value) =
        sqlx::query_as("SELECT event_key,event FROM loop_runs WHERE loop_id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(key, "schedule:2030-03-28T12:01:00.000Z");
    assert_eq!(
        event,
        json!({"kind":"schedule","scheduledAt":"2030-03-28T12:01:00.000Z"})
    );
    let next: DateTime<Utc> = sqlx::query_scalar("SELECT next_run_at FROM team_loops WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(next, now + Duration::hours(1));
    assert_eq!(
        s.enqueue_scheduled(now, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        0
    );
    assert_eq!(count(&f, id).await, 1);
    s.options.enabled = false;
    assert_eq!(
        s.enqueue_scheduled(next, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        0
    );
    assert_eq!(count(&f, id).await, 1);
}

#[tokio::test]
async fn cycle_scans_use_saved_timezone_inclusive_dates_and_no_backfill_before_enablement() {
    let f = Fixture::new().await;
    let s = loop_acceptance::service(&f);
    let team = issue_acceptance::team(&f, 97).await;
    let cycle = Uuid::new_v4();
    sqlx::query("UPDATE teams SET timezone='UTC' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO issue_cycles(id,workspace_id,team_id,number,timezone,start_date,end_date) VALUES($1,$2,$3,1,'Europe/Paris','2030-03-31','2030-03-31')").bind(cycle).bind(&f.actor.workspace_id).bind(team).execute(&f.pool).await.unwrap();
    let start = definition(
        &f,
        &s,
        team,
        json!({"kind":"event","entity":"cycle","event":"started"}),
        false,
    )
    .await;
    let end = definition(
        &f,
        &s,
        team,
        json!({"kind":"event","entity":"cycle","event":"completed"}),
        false,
    )
    .await;
    sqlx::query("UPDATE team_loops SET enabled_at='2030-03-30T20:00:00Z' WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    for (now, starts, ends) in [
        ("2030-03-30T22:59:59.999Z", 0, 0),
        ("2030-03-30T23:00:00Z", 1, 0),
        ("2030-03-31T21:59:59.999Z", 1, 0),
        ("2030-03-31T22:00:00Z", 1, 1),
        ("2030-03-31T22:00:00Z", 1, 1),
    ] {
        s.enqueue_scheduled(at(now), Some(&f.actor.workspace_id))
            .await
            .unwrap();
        assert_eq!(
            (count(&f, start).await, count(&f, end).await),
            (starts, ends),
            "{now}"
        );
    }
    let late = definition(
        &f,
        &s,
        team,
        json!({"kind":"event","entity":"cycle","event":"completed"}),
        false,
    )
    .await;
    sqlx::query("UPDATE team_loops SET enabled_at='2030-03-31T23:00:00Z' WHERE id=$1")
        .bind(late)
        .execute(&f.pool)
        .await
        .unwrap();
    // Existing cycle receipts count in the source report, but are not inserted again.
    assert_eq!(
        s.enqueue_scheduled(at("2030-04-01T00:00:00Z"), Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        2
    );
    assert_eq!(count(&f, late).await, 0);
    let event: Value = sqlx::query_scalar("SELECT event FROM loop_runs WHERE loop_id=$1")
        .bind(end)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(event["context"]["timezone"], "Europe/Paris");
    assert_eq!(event["context"]["team"], team.to_string());
}

#[tokio::test]
async fn expiry_uses_original_deadlines_preserves_cancellation_and_never_requeues_uncertain_work() {
    let f = Fixture::new().await;
    let foreign = Fixture::new().await;
    let mut s = loop_acceptance::service(&f);
    let team = issue_acceptance::team(&f, 98).await;
    let foreign_team = issue_acceptance::team(&foreign, 99).await;
    let trigger = json!({"kind":"event","entity":"issue","event":"created"});
    let id = definition(&f, &s, team, trigger.clone(), false).await;
    let other = definition(
        &foreign,
        &loop_acceptance::service(&foreign),
        foreign_team,
        trigger,
        false,
    )
    .await;
    let now = at("2030-01-01T12:00:00Z");
    let mut ids = Vec::new();
    for (index, state, started, lease, decision) in [
        (
            0,
            "waiting-for-approval",
            Some(now - Duration::minutes(4)),
            Some(now),
            json!({"action":"approve"}),
        ),
        (
            1,
            "waiting-for-approval",
            Some(now - Duration::minutes(6)),
            Some(now),
            json!({"action":"cancel-run"}),
        ),
        (
            2,
            "running",
            Some(now),
            Some(now - Duration::minutes(5)),
            json!({"action":"approve"}),
        ),
        (
            3,
            "running",
            Some(now - Duration::minutes(8)),
            Some(now),
            Value::Null,
        ),
        (
            4,
            "waiting-for-approval",
            None,
            Some(now - Duration::minutes(9)),
            Value::Null,
        ),
        (
            5,
            "queued",
            Some(now - Duration::minutes(9)),
            Some(now - Duration::minutes(9)),
            Value::Null,
        ),
    ] {
        let run = Uuid::new_v4();
        ids.push(run);
        sqlx::query("INSERT INTO loop_runs(id,workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state,started_at,lease_at,pending_decision,result) SELECT $1,workspace_id,id,revision,$2,'fixture','{}',fields,enabled_by_id,$3,$4,$5,NULLIF($6::jsonb,'null'::jsonb),'Retain result' FROM team_loops WHERE id=$7")
            .bind(run).bind(format!("expiry-{index}")).bind(state).bind(started).bind(lease).bind(decision).bind(id).execute(&f.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO loop_runs(workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state,started_at) SELECT workspace_id,id,revision,'foreign','fixture','{}',fields,enabled_by_id,'waiting-for-approval',$1 FROM team_loops WHERE id=$2").bind(now-Duration::minutes(9)).bind(other).execute(&f.pool).await.unwrap();
    s.options.enabled = false;
    assert_eq!(
        s.expire_runs(now, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        ExpiredRuns::default()
    );
    s.options.enabled = true;
    assert_eq!(
        s.expire_runs(now, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        ExpiredRuns {
            approvals: 1,
            workers: 1
        }
    );
    type ExpiryRow = (Uuid, String, Option<String>, Option<Value>, String);
    let rows: Vec<ExpiryRow> = sqlx::query_as(
        "SELECT id,state,error_code,pending_decision,result FROM loop_runs WHERE loop_id=$1",
    )
    .bind(id)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    let states = rows
        .iter()
        .map(|r| (r.0, r.1.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        ids.iter().map(|id| states[id]).collect::<Vec<_>>(),
        vec![
            "failed",
            "waiting-for-approval",
            "uncertain",
            "running",
            "waiting-for-approval",
            "queued"
        ]
    );
    assert!(rows.iter().all(|r| r.4 == "Retain result"));
    let expired = rows.iter().find(|r| r.0 == ids[0]).unwrap();
    assert_eq!(expired.2.as_deref(), Some("RUN_WALL_CLOCK_LIMIT"));
    assert!(expired.3.is_none());
    let uncertain = rows.iter().find(|r| r.0 == ids[2]).unwrap();
    assert_eq!(uncertain.2.as_deref(), Some("WORKER_LEASE_EXPIRED"));
    assert_eq!(uncertain.3, Some(json!({"action":"approve"})));
    assert_eq!(
        s.expire_runs(now, Some(&f.actor.workspace_id))
            .await
            .unwrap(),
        ExpiredRuns::default()
    );
    let foreign_state: String = sqlx::query_scalar("SELECT state FROM loop_runs WHERE loop_id=$1")
        .bind(other)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(foreign_state, "waiting-for-approval");
}

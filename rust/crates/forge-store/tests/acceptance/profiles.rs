use super::{Authentication, Fixture};
use forge_core::files::{UploadError, upload};
use forge_store::{StoreError, profiles};
use serde_json::{Value, json};
use uuid::Uuid;
struct Inspector;
#[async_trait::async_trait]
impl upload::Inspector for Inspector {
    async fn detect(&self, _: &[u8]) -> Result<Option<String>, UploadError> {
        Ok(None)
    }
}
async fn command(f: &Fixture, patch: Value) -> Value {
    let snapshot = profiles::read(&f.database, &f.actor, true).await.unwrap();
    let Authentication::Session { session_id } = &f.actor.authentication else {
        panic!()
    };
    json!({"commandKey":Uuid::new_v4(),"sessionId":session_id,"expectedWorkspaceId":f.actor.workspace_id,"expectedRevision":snapshot["revision"],"patch":patch})
}
async fn patch(f: &Fixture, input: Value) -> Result<Value, StoreError> {
    profiles::patch(&f.database, &f.actor, input, true, &Inspector).await
}

#[tokio::test]
async fn independent_profile_edits_serialize_and_advance_a_frozen_millisecond_revision() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let untouched = profiles::read(&other.database, &other.actor, true)
        .await
        .unwrap();
    sqlx::query("UPDATE \"user\" SET updated_at='2099-01-01T00:00:00Z' WHERE id=$1")
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let input=command(&f,json!({"name":" Alice ","title":" Engineer ","username":format!("u_{}",Uuid::new_v4().simple()).chars().take(32).collect::<String>()})).await;
    let mut competing = input.clone();
    competing["commandKey"] = json!(Uuid::new_v4());
    competing["patch"] = json!({"name":"Other name","title":"Other title"});
    let (a, b) = tokio::join!(patch(&f, input.clone()), patch(&f, competing));
    let a = a.unwrap();
    let b = b.unwrap();
    let mut statuses = vec![a["status"].as_str().unwrap(), b["status"].as_str().unwrap()];
    statuses.sort();
    assert_eq!(statuses, vec!["conflict", "saved"]);
    let snapshot = profiles::read(&f.database, &f.actor, true).await.unwrap();
    assert_eq!(snapshot["revision"], "2099-01-01T00:00:00.001Z");
    let mut stale = input;
    stale["commandKey"] = json!(Uuid::new_v4());
    assert_eq!(patch(&f, stale).await.unwrap()["status"], "conflict");
    assert_eq!(
        profiles::read(&other.database, &other.actor, true)
            .await
            .unwrap(),
        untouched
    );
}
#[tokio::test]
async fn profile_replay_is_minimal_session_bound_and_revoked_live() {
    let f = Fixture::new().await;
    let input = command(&f, json!({"title":"Private profile detail"})).await;
    let first = patch(&f, input.clone()).await.unwrap();
    assert_eq!(first["snapshot"]["title"], "Private profile detail");
    assert_eq!(patch(&f, input.clone()).await.unwrap(), first);
    let receipts:Vec<(String,i64,i64)>=sqlx::query_as("SELECT r.response_body,(SELECT count(*) FROM command_audit_events a WHERE a.command_id=r.id),(SELECT count(*) FROM command_outbox_events e WHERE e.command_id=r.id) FROM command_receipts r WHERE r.command_key=$1").bind(input["commandKey"].as_str().unwrap()).fetch_all(&f.pool).await.unwrap();
    assert_eq!(receipts.len(), 1);
    assert!(!receipts[0].0.contains("Private profile detail"));
    assert_eq!((receipts[0].1, receipts[0].2), (1, 0));
    let mut reused = input.clone();
    reused["patch"] = json!({"title":"Changed key input"});
    assert!(matches!(
        patch(&f, reused).await,
        Err(StoreError::CommandReused)
    ));
    for (key, value) in [
        ("sessionId", "another-session"),
        ("expectedWorkspaceId", "another-workspace"),
    ] {
        let mut wrong = input.clone();
        wrong[key] = json!(value);
        assert!(matches!(patch(&f, wrong).await, Err(StoreError::Forbidden)));
    }
    for authentication in [
        Authentication::ApiKey {
            credential_id: "key".into(),
        },
        Authentication::Agent {
            run_id: Uuid::new_v4().to_string(),
            token_id: "token".into(),
        },
    ] {
        let mut actor = f.actor.clone();
        actor.authentication = authentication;
        assert!(matches!(
            profiles::read(&f.database, &actor, true).await,
            Err(StoreError::Forbidden)
        ));
        assert!(matches!(
            profiles::patch(&f.database, &actor, input.clone(), true, &Inspector).await,
            Err(StoreError::Forbidden)
        ));
    }
    assert!(matches!(
        profiles::read(&f.database, &f.actor, false).await,
        Err(StoreError::ProfileDisabled)
    ));
    assert!(matches!(
        profiles::patch(&f.database, &f.actor, input.clone(), false, &Inspector).await,
        Err(StoreError::ProfileDisabled)
    ));
    sqlx::query("UPDATE session SET expires_at=now()-interval '1 minute' WHERE token=$1")
        .bind(&f.token)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(patch(&f, input).await, Err(StoreError::Forbidden)));
    assert!(matches!(
        profiles::read(&f.database, &f.actor, true).await,
        Err(StoreError::Forbidden)
    ));
}
#[tokio::test]
async fn taken_username_bad_avatar_and_protected_fields_preserve_the_entire_profile() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let username = format!("u_{}", Uuid::new_v4().simple())
        .chars()
        .take(25)
        .collect::<String>();
    sqlx::query("UPDATE \"user\" SET username=$1 WHERE id=$2")
        .bind(&username)
        .bind(&other.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let before = profiles::read(&f.database, &f.actor, true).await.unwrap();
    for values in [
        json!({"title":"Must roll back","username":username}),
        json!({"title":"Must roll back","image":"data:image/png;base64,SGVsbG8="}),
    ] {
        let input = command(&f, values).await;
        let key = input["commandKey"].as_str().unwrap().to_owned();
        let result = patch(&f, input).await.unwrap();
        assert_eq!(result["status"], "rejected");
        assert_eq!(
            profiles::read(&f.database, &f.actor, true).await.unwrap(),
            before
        );
        let receipts: i64 =
            sqlx::query_scalar("SELECT count(*) FROM command_receipts WHERE command_key=$1")
                .bind(key)
                .fetch_one(&f.pool)
                .await
                .unwrap();
        assert_eq!(receipts, 0);
    }
    for field in [
        "role",
        "userId",
        "emailVerified",
        "preferences",
        "accountId",
    ] {
        let mut input = command(&f, json!({"title":"Must not commit"})).await;
        input["patch"][field] = json!(true);
        assert!(matches!(
            patch(&f, input).await,
            Err(StoreError::InvalidInput)
        ));
    }
    let input = command(
        &f,
        json!({"name":" Owner name ","title":" Engineer ","username":format!("{username}_ok")}),
    )
    .await;
    let saved = patch(&f, input).await.unwrap();
    assert_eq!(saved["snapshot"]["name"], "Owner name");
    assert_eq!(saved["snapshot"]["title"], "Engineer");
    let input = command(&f, json!({"username":null,"image":null})).await;
    let saved = patch(&f, input).await.unwrap();
    assert!(saved["snapshot"]["username"].is_null());
    assert_eq!(saved["snapshot"]["title"], "Engineer");
}
#[tokio::test]
async fn profile_and_receipt_roll_back_when_audit_publication_fails() {
    let f = Fixture::new().await;
    let name = format!("profile_audit_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected profile audit failure'; END $$")).execute(&f.pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {name} BEFORE INSERT ON command_audit_events FOR EACH ROW WHEN (NEW.actor_user_id='{}') EXECUTE FUNCTION {name}()",f.actor.user_id)).execute(&f.pool).await.unwrap();
    let before = profiles::read(&f.database, &f.actor, true).await.unwrap();
    let input = command(&f, json!({"title":"Rollback title"})).await;
    let result = patch(&f, input.clone()).await;
    sqlx::query(&format!("DROP TRIGGER {name} ON command_audit_events"))
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query(&format!("DROP FUNCTION {name}()"))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(result.is_err());
    assert_eq!(
        profiles::read(&f.database, &f.actor, true).await.unwrap(),
        before
    );
    let receipts: i64 =
        sqlx::query_scalar("SELECT count(*) FROM command_receipts WHERE command_key=$1")
            .bind(input["commandKey"].as_str().unwrap())
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(receipts, 0);
    assert_eq!(patch(&f, input).await.unwrap()["status"], "saved");
}

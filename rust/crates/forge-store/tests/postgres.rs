use async_trait::async_trait;
use forge_core::actor::{Actor, ApiScope, Authentication};
use forge_store::{
    StoreError,
    authority::{api_key_actor, api_key_hash, current_actor, session_actor},
    commands::{Command, CommandHandler, CommandResult, OutboxEvent, execute},
};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

struct Fixture {
    pool: PgPool,
    database: forge_store::Database,
    actor: Actor,
    token: String,
}

impl Fixture {
    async fn new() -> Self {
        // This suite fails without the isolated runner instead of silently skipping.
        let connection = std::env::var("FORGE_RUST_TEST_DATABASE_URL")
            .expect("Run bun run rewrite:verify, or python3 scripts/test-rust-postgres.py");
        let options: sqlx::postgres::PgConnectOptions = connection.parse().unwrap();
        assert_eq!(
            options.get_host(),
            "127.0.0.1",
            "Tests require disposable loopback PostgreSQL"
        );
        assert_eq!(options.get_username(), "forge_rust_test");
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .connect_with(options)
            .await
            .unwrap();
        let user_id = Uuid::new_v4().to_string();
        let workspace_id = Uuid::new_v4().to_string();
        let session_id = Uuid::new_v4().to_string();
        let token = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO \"user\"(id,name,email,email_verified) VALUES($1,'Original Actor',$2,true)")
            .bind(&user_id).bind(format!("{user_id}@example.test")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO organization(id,name,slug) VALUES($1,'Test workspace',$1)")
            .bind(&workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')")
            .bind(Uuid::new_v4().to_string())
            .bind(&workspace_id)
            .bind(&user_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')")
            .bind(&session_id).bind(&token).bind(&user_id).bind(&workspace_id).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO account_preferences(user_id) VALUES($1)")
            .bind(&user_id)
            .execute(&pool)
            .await
            .unwrap();
        let actor = Actor {
            user_id,
            workspace_id,
            workspace_role: "owner".into(),
            authentication: Authentication::Session { session_id },
            scopes: None,
            loop_scope: None,
        };
        Self {
            database: forge_store::Database::new(pool.clone()),
            pool,
            actor,
            token,
        }
    }

    async fn create_key(&self, maximum: i32) -> (String, String) {
        let credential = format!("forge_{}", Uuid::new_v4());
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO apikey(id,config_id,reference_id,key,permissions,metadata,rate_limit_time_window,rate_limit_max) VALUES($1,'forge-api',$2,$3,$4,$5,60000,$6)")
            .bind(&id).bind(&self.actor.user_id).bind(api_key_hash(&credential))
            .bind(json!({"issues":["read","write"],"teams":["read"]}).to_string())
            .bind(json!({"workspaceId":self.actor.workspace_id}).to_string()).bind(maximum).execute(&self.pool).await.unwrap();
        (credential, id)
    }

    async fn effect_count(&self) -> i32 {
        sqlx::query_scalar("SELECT revision FROM account_preferences WHERE user_id=$1")
            .bind(&self.actor.user_id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

struct PreferenceChange {
    fail_after_write: bool,
    require_admin: bool,
}

#[async_trait]
impl CommandHandler for PreferenceChange {
    type Output = Value;

    async fn authorize(
        &self,
        _connection: &mut PgConnection,
        actor: &Actor,
        value: Option<&Value>,
    ) -> Result<(), StoreError> {
        actor
            .require_scope(ApiScope::IssuesWrite)
            .map_err(|_| StoreError::Forbidden)?;
        if self.require_admin && !actor.has_role(&["admin", "owner"]) {
            return Err(StoreError::Forbidden);
        }
        if value.is_some_and(|value| value["workspaceId"].as_str() != Some(&actor.workspace_id)) {
            return Err(StoreError::Forbidden);
        }
        Ok(())
    }

    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<Value>, StoreError> {
        let revision: i32 = sqlx::query_scalar("UPDATE account_preferences SET revision=revision+1 WHERE user_id=$1 RETURNING revision")
            .bind(&actor.user_id).fetch_one(connection).await?;
        if self.fail_after_write {
            return Err(StoreError::InvalidInput);
        }
        Ok(CommandResult {
            value: json!({"workspaceId": actor.workspace_id, "revision": revision}),
            resource_type: "preferences".into(),
            resource_id: actor.user_id.clone(),
            events: vec![OutboxEvent {
                topic: "issue.fixture".into(),
                payload: serde_json::Map::new(),
            }],
        })
    }
}

fn command<'a>(key: &'a str, input: &'a Value) -> Command<'a> {
    Command {
        key,
        operation: "fixture.preferences",
        input,
        status: 200,
    }
}

#[tokio::test]
async fn session_authority_uses_live_membership_verification_and_expiry() {
    let fixture = Fixture::new().await;
    let actor = session_actor(&fixture.database, &fixture.token)
        .await
        .unwrap();
    assert_eq!(actor.workspace_role, "admin");
    assert!(actor.scopes.is_none());
    sqlx::query("UPDATE \"user\" SET email_verified=false WHERE id=$1")
        .bind(&actor.user_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        session_actor(&fixture.database, &fixture.token).await,
        Err(StoreError::EmailNotVerified)
    ));
    sqlx::query("UPDATE session SET expires_at=now()-interval '1 second' WHERE token=$1")
        .bind(&fixture.token)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        session_actor(&fixture.database, &fixture.token).await,
        Err(StoreError::Unauthenticated)
    ));
}

#[tokio::test]
async fn session_falls_back_to_a_live_workspace_and_persists_the_selection() {
    let fixture = Fixture::new().await;
    sqlx::query("UPDATE session SET active_organization_id=NULL WHERE token=$1")
        .bind(&fixture.token)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let actor = session_actor(&fixture.database, &fixture.token)
        .await
        .unwrap();
    assert_eq!(actor.workspace_id, fixture.actor.workspace_id);
    let active: Option<String> =
        sqlx::query_scalar("SELECT active_organization_id FROM session WHERE token=$1")
            .bind(&fixture.token)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(active.as_deref(), Some(actor.workspace_id.as_str()));
}

#[tokio::test]
async fn concurrent_key_checks_cannot_exceed_the_rate_limit() {
    let fixture = Fixture::new().await;
    let (credential, _) = fixture.create_key(3).await;
    let mut tasks = vec![];
    for _ in 0..12 {
        let pool = fixture.database.clone();
        let credential = credential.clone();
        tasks.push(tokio::spawn(async move {
            api_key_actor(&pool, &credential).await
        }));
    }
    let mut accepted = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(actor) => {
                accepted += 1;
                assert_eq!(actor.workspace_role, "admin");
                assert!(!actor.has_scope(ApiScope::TeamsWrite));
            }
            Err(StoreError::RateLimited) => {}
            other => panic!("Unexpected credential result: {other:?}"),
        }
    }
    assert_eq!(accepted, 3);
}

#[tokio::test]
async fn api_key_scopes_are_intersected_with_live_authority() {
    let fixture = Fixture::new().await;
    let (credential, key_id) = fixture.create_key(600).await;
    let actor = api_key_actor(&fixture.database, &credential).await.unwrap();
    assert!(actor.has_scope(ApiScope::IssuesWrite));
    sqlx::query("UPDATE apikey SET permissions=$1 WHERE id=$2")
        .bind(json!({"issues":["read"]}).to_string())
        .bind(&key_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let mut tx = fixture.pool.begin().await.unwrap();
    let refreshed = current_actor(&mut tx, &actor).await.unwrap();
    assert_eq!(refreshed.scopes, Some(vec![ApiScope::IssuesRead]));
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE apikey SET enabled=false WHERE id=$1")
        .bind(&key_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        api_key_actor(&fixture.database, &credential).await,
        Err(StoreError::Unauthenticated)
    ));
}

#[tokio::test]
async fn concurrent_retries_commit_one_effect_audit_and_outbox() {
    let fixture = Fixture::new().await;
    let mut tasks = vec![];
    for _ in 0..8 {
        let pool = fixture.database.clone();
        let actor = fixture.actor.clone();
        tasks.push(tokio::spawn(async move {
            execute(
                &pool,
                &actor,
                command("same-key", &json!({"a":1})),
                &PreferenceChange {
                    fail_after_write: false,
                    require_admin: true,
                },
            )
            .await
        }));
    }
    let mut fresh = 0;
    for task in tasks {
        let result = task.await.unwrap().unwrap();
        if !result.replayed {
            fresh += 1;
        }
        assert_eq!(result.value["revision"], 1);
    }
    assert_eq!(fresh, 1);
    assert_eq!(fixture.effect_count().await, 1);
    let audits: i64 =
        sqlx::query_scalar("SELECT count(*) FROM command_audit_events WHERE workspace_id=$1")
            .bind(&fixture.actor.workspace_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(audits, 1);
    let payloads: Vec<(Value,)> =
        sqlx::query_as("SELECT payload FROM command_outbox_events WHERE workspace_id=$1")
            .bind(&fixture.actor.workspace_id)
            .fetch_all(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(payloads.len(), 1);
    assert_eq!(
        payloads[0].0["history"]["actor"]["userId"],
        fixture.actor.user_id
    );
    assert_eq!(payloads[0].0["history"]["actor"]["name"], "Original Actor");
}

#[tokio::test]
async fn failed_effect_rolls_back_the_reservation_and_can_be_retried() {
    let fixture = Fixture::new().await;
    let input = json!({"a":1});
    let result = execute(
        &fixture.database,
        &fixture.actor,
        command("retry-key", &input),
        &PreferenceChange {
            fail_after_write: true,
            require_admin: true,
        },
    )
    .await;
    assert!(matches!(result, Err(StoreError::InvalidInput)));
    assert_eq!(fixture.effect_count().await, 0);
    let receipt_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM command_receipts WHERE workspace_id=$1")
            .bind(&fixture.actor.workspace_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(receipt_count, 0);
    assert!(
        !execute(
            &fixture.database,
            &fixture.actor,
            command("retry-key", &input),
            &PreferenceChange {
                fail_after_write: false,
                require_admin: true
            }
        )
        .await
        .unwrap()
        .replayed
    );
    assert_eq!(fixture.effect_count().await, 1);
}

#[tokio::test]
async fn changed_input_and_revoked_authority_cannot_replay_a_receipt() {
    let fixture = Fixture::new().await;
    let handler = PreferenceChange {
        fail_after_write: false,
        require_admin: true,
    };
    execute(
        &fixture.database,
        &fixture.actor,
        command("saved-key", &json!({"a":1})),
        &handler,
    )
    .await
    .unwrap();
    assert!(matches!(
        execute(
            &fixture.database,
            &fixture.actor,
            command("saved-key", &json!({"a":2})),
            &handler
        )
        .await,
        Err(StoreError::CommandReused)
    ));
    sqlx::query("UPDATE member SET role='member' WHERE user_id=$1 AND organization_id=$2")
        .bind(&fixture.actor.user_id)
        .bind(&fixture.actor.workspace_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        execute(
            &fixture.database,
            &fixture.actor,
            command("saved-key", &json!({"a":1})),
            &handler
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(fixture.effect_count().await, 1);
}

#[tokio::test]
async fn unavailable_receipts_fail_without_repeating_the_effect() {
    let fixture = Fixture::new().await;
    let handler = PreferenceChange {
        fail_after_write: false,
        require_admin: true,
    };
    execute(
        &fixture.database,
        &fixture.actor,
        command("saved-key", &json!({"a":1})),
        &handler,
    )
    .await
    .unwrap();
    sqlx::query("UPDATE command_receipts SET response_body=NULL WHERE workspace_id=$1")
        .bind(&fixture.actor.workspace_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        execute(
            &fixture.database,
            &fixture.actor,
            command("saved-key", &json!({"a":1})),
            &handler
        )
        .await,
        Err(StoreError::CommandResultUnavailable)
    ));
    assert_eq!(fixture.effect_count().await, 1);
}

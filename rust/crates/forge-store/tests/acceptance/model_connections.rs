use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use forge_core::agents::providers::{self as policy, Code};
use forge_store::agents::model_connections::Service;
use std::sync::{Arc, atomic::Ordering};
#[path = "../support/model_discovery.rs"]
mod discovery;
fn service(f: &Fixture) -> (Service, Arc<discovery::Provider>) {
    let provider = Arc::new(discovery::Provider::default());
    let vault =
        Arc::new(forge_identity::model_vault::Vault::new(&STANDARD.encode([7; 32])).unwrap());
    let mut service = Service::new(f.database.clone(), provider.clone(), vault);
    service.now = Arc::new(at);
    (service, provider)
}
fn input(scope: &str) -> Value {
    json!({"provider":"openai","scope":scope,"displayName":"Fixture API","apiKey":"fixture-secret-1234"})
}
fn id(v: &Value) -> Uuid {
    v["id"].as_str().unwrap().parse().unwrap()
}
fn code<T: std::fmt::Debug>(result: Result<T, StoreError>, expected: Code) {
    match result.unwrap_err() {
        StoreError::ModelConnection(error) => assert_eq!(error.code, expected),
        other => panic!("Unexpected {other:?}"),
    }
}

#[tokio::test]
async fn model_connections_are_encrypted_private_and_workspace_write_requires_live_admin() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let (service, _) = service(&f);
    let personal = service.create(&f.actor, input("personal")).await.unwrap();
    let workspace = service.create(&f.actor, input("workspace")).await.unwrap();
    assert_eq!(personal["maskedCredentialSuffix"], "1234");
    assert_eq!(personal["modelCount"], 1);
    for field in ["secretReference", "apiKey", "metadata", "createdByUserId"] {
        assert!(personal.get(field).is_none());
    }
    let reference: String =
        sqlx::query_scalar("SELECT secret_reference FROM model_connections WHERE id=$1")
            .bind(id(&personal))
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(!reference.contains("fixture-secret"));
    assert_eq!(
        service
            .vault
            .open(
                &reference,
                &format!("{}:{}", f.actor.workspace_id, id(&personal))
            )
            .unwrap(),
        "fixture-secret-1234"
    );
    assert!(
        service
            .vault
            .open(
                &reference,
                &format!("{}:{}", other.actor.workspace_id, id(&personal))
            )
            .is_err()
    );
    assert_eq!(service.list(&f.actor).await.unwrap().len(), 2);
    let visible = service.list(&member).await.unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0]["id"], workspace["id"]);
    code(
        service.delete(&member, id(&personal)).await,
        Code::ConnectionNotFound,
    );
    assert!(matches!(
        service.create(&member, input("workspace")).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        service.delete(&member, id(&workspace)).await,
        Err(StoreError::Forbidden)
    ));
    let own = service.create(&member, input("personal")).await.unwrap();
    assert_eq!(own["userId"], member.user_id);
    assert_eq!(service.catalog(&member, false).await.unwrap().len(), 2);
    service.delete(&member, id(&own)).await.unwrap();
    assert_eq!(service.catalog(&member, false).await.unwrap().len(), 1);
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        service.delete(&f.actor, id(&workspace)).await,
        Err(StoreError::Forbidden)
    ));
    service.delete(&f.actor, id(&personal)).await.unwrap();
}

#[tokio::test]
async fn connection_creation_is_atomic_and_policy_blocks_before_discovery() {
    let f = Fixture::new().await;
    let (mut service, provider) = service(&f);
    service.allowed_providers = Some(std::collections::HashSet::new());
    code(
        service.create(&f.actor, input("personal")).await,
        Code::PolicyBlocked,
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    service.allowed_providers = None;
    provider.fail.store(true, Ordering::SeqCst);
    code(
        service.create(&f.actor, input("personal")).await,
        Code::DiscoveryFailed,
    );
    provider.fail.store(false, Ordering::SeqCst);
    provider.models.lock().unwrap().clear();
    code(
        service.create(&f.actor, input("personal")).await,
        Code::DiscoveryFailed,
    );
    *provider.models.lock().unwrap() = policy::normalize("openai", None, &["gpt-5".into()]);
    let name = format!("reject_model_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM model_connections WHERE id=NEW.connection_id AND workspace_id='{}') THEN RAISE EXCEPTION 'fixture rejected catalog'; END IF; RETURN NEW; END $$",f.actor.workspace_id)).execute(&f.pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {name} BEFORE INSERT ON model_catalog_entries FOR EACH ROW EXECUTE FUNCTION {name}()" )).execute(&f.pool).await.unwrap();
    assert!(service.create(&f.actor, input("personal")).await.is_err());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM model_connections WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    sqlx::query(&format!("DROP TRIGGER {name} ON model_catalog_entries"))
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query(&format!("DROP FUNCTION {name}()"))
        .execute(&f.pool)
        .await
        .unwrap();
    let saved = service.create(&f.actor, input("personal")).await.unwrap();
    service.allowed_providers = Some(std::collections::HashSet::new());
    let list = service.list(&f.actor).await.unwrap();
    assert_eq!(list[0]["status"], "policy-blocked");
    assert_eq!(list[0]["modelCount"], 1);
    code(
        service.refresh(&f.actor, id(&saved)).await,
        Code::PolicyBlocked,
    );
    service.delete(&f.actor, id(&saved)).await.unwrap();
}

#[tokio::test]
async fn refresh_updates_health_atomically_preserves_catalog_on_failure_and_filters_expiry() {
    let f = Fixture::new().await;
    let (service, provider) = service(&f);
    let saved = service.create(&f.actor, input("personal")).await.unwrap();
    let id = id(&saved);
    *provider.models.lock().unwrap() =
        policy::normalize("openai", None, &["gpt-5-new".into(), "o3-mini".into()]);
    assert_eq!(
        service.refresh(&f.actor, id).await.unwrap()["modelCount"],
        2
    );
    assert_eq!(service.catalog(&f.actor, true).await.unwrap().len(), 2);
    provider.fail.store(true, Ordering::SeqCst);
    code(service.refresh(&f.actor, id).await, Code::DiscoveryFailed);
    let list = service.list(&f.actor).await.unwrap();
    assert_eq!(list[0]["status"], "repair-required");
    assert_eq!(list[0]["modelCount"], 2);
    assert!(!list[0].to_string().contains("Private fixture"));
    assert!(service.catalog(&f.actor, true).await.unwrap().is_empty());
    provider.fail.store(false, Ordering::SeqCst);
    provider.models.lock().unwrap().clear();
    assert_eq!(
        service.refresh(&f.actor, id).await.unwrap()["modelCount"],
        0
    );
    *provider.models.lock().unwrap() = policy::normalize("openai", None, &["gpt-5".into()]);
    service
        .refresh_for_routing(&f.actor, Some(id))
        .await
        .unwrap();
    sqlx::query("UPDATE model_catalog_entries SET expires_at=$2 WHERE connection_id=$1")
        .bind(id)
        .bind(at())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(service.catalog(&f.actor, true).await.unwrap().is_empty());
    sqlx::query("UPDATE model_catalog_entries SET expires_at=$2 WHERE connection_id=$1")
        .bind(id)
        .bind(at() + Duration::milliseconds(1))
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(service.catalog(&f.actor, true).await.unwrap().len(), 1);
}

#[tokio::test]
async fn revocation_during_discovery_prevents_publication_and_old_refresh_cannot_replace_new() {
    let f = Fixture::new().await;
    let (service, provider) = service(&f);
    provider.pause.store(true, Ordering::SeqCst);
    let (created, ()) = tokio::join!(service.create(&f.actor, input("workspace")), async {
        provider.entered.notified().await;
        sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
            .bind(&f.actor.workspace_id)
            .bind(&f.actor.user_id)
            .execute(&f.pool)
            .await
            .unwrap();
        provider.resume.notify_one();
    });
    assert!(matches!(created, Err(StoreError::Forbidden)));
    let saved = service.create(&f.actor, input("personal")).await.unwrap();
    let id = id(&saved);
    provider.pause.store(true, Ordering::SeqCst);
    let (slow, fast) = tokio::join!(service.refresh(&f.actor, id), async {
        provider.entered.notified().await;
        *provider.models.lock().unwrap() = policy::normalize("openai", None, &["gpt-newer".into()]);
        let result = service.refresh(&f.actor, id).await;
        provider.resume.notify_one();
        result
    });
    assert!(slow.is_ok());
    assert!(fast.is_ok());
    assert_eq!(
        service.catalog(&f.actor, true).await.unwrap()[0]["modelId"],
        "gpt-newer"
    );
    provider.pause.store(true, Ordering::SeqCst);
    let (refresh, ()) = tokio::join!(service.refresh(&f.actor, id), async {
        provider.entered.notified().await;
        service.delete(&f.actor, id).await.unwrap();
        provider.resume.notify_one();
    });
    code(refresh, Code::ConnectionNotFound);
    provider.pause.store(true, Ordering::SeqCst);
    let (create, ()) = tokio::join!(service.create(&f.actor, input("personal")), async {
        provider.entered.notified().await;
        sqlx::query("DELETE FROM session WHERE token=$1")
            .bind(&f.token)
            .execute(&f.pool)
            .await
            .unwrap();
        provider.resume.notify_one();
    });
    assert!(matches!(create, Err(StoreError::Forbidden)));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM model_connections WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn managed_catalog_has_stable_workspace_identity_without_storing_environment_secrets() {
    let f = Fixture::new().await;
    let (mut service, _) = service(&f);
    service
        .managed_environment
        .insert("OPENAI_API_KEY".into(), "fixture-managed-key".into());
    service.managed_environment.insert(
        "FORGE_MANAGED_OPENAI_MODELS".into(),
        "gpt-managed, gpt-managed".into(),
    );
    let (a, b) = tokio::join!(
        service.catalog(&f.actor, true),
        service.catalog(&f.actor, false)
    );
    assert_eq!(a.unwrap(), b.unwrap());
    let list = service.list(&f.actor).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["id"], policy::managed_id(&f.actor.workspace_id));
    assert_eq!(list[0]["modelCount"], 0);
    let secret: Option<String> =
        sqlx::query_scalar("SELECT secret_reference FROM model_connections WHERE id=$1")
            .bind(id(&list[0]))
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(secret.is_none());
    code(
        service.refresh(&f.actor, id(&list[0])).await,
        Code::VaultUnavailable,
    );
    service.delete(&f.actor, id(&list[0])).await.unwrap();
    assert_eq!(service.catalog(&f.actor, true).await.unwrap().len(), 1);
}

#[tokio::test]
async fn model_read_write_and_routing_scopes_are_distinct_and_revocation_is_live() {
    let f = Fixture::new().await;
    let (service, provider) = service(&f);
    let saved = service.create(&f.actor, input("workspace")).await.unwrap();
    let (credential, key) = f.create_key(600).await;
    sqlx::query("UPDATE apikey SET permissions=$1 WHERE id=$2")
        .bind(json!({"model-connections":["read"],"agents":["write"]}).to_string())
        .bind(&key)
        .execute(&f.pool)
        .await
        .unwrap();
    let actor = api_key_actor(&f.database, &credential).await.unwrap();
    assert_eq!(service.list(&actor).await.unwrap().len(), 1);
    assert_eq!(service.catalog(&actor, false).await.unwrap().len(), 1);
    assert_eq!(service.catalog(&actor, true).await.unwrap().len(), 1);
    assert!(matches!(
        service.create(&actor, input("personal")).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        service.refresh(&actor, id(&saved)).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        service.delete(&actor, id(&saved)).await,
        Err(StoreError::Forbidden)
    ));
    service
        .refresh_for_routing(&actor, Some(id(&saved)))
        .await
        .unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    sqlx::query("UPDATE apikey SET permissions=$1 WHERE id=$2")
        .bind(json!({"model-connections":["read"]}).to_string())
        .bind(&key)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        service.catalog(&actor, true).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        service.refresh_for_routing(&actor, None).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE apikey SET enabled=false WHERE id=$1")
        .bind(&key)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        service.list(&actor).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn deleting_a_selected_connection_restores_default_preferences_and_clears_run_reference() {
    let f = Fixture::new().await;
    let (service, _) = service(&f);
    let saved = service.create(&f.actor, input("personal")).await.unwrap();
    let connection = id(&saved);
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    preferences::upsert(
        &f.database,
        &Preference {
            thread_id: thread.id,
            mode: SelectionMode::Manual,
            selected_connection_id: Some(connection),
            selected_model_id: Some("gpt-5".into()),
            selected_effort: Some(Effort::High),
            updated_at: at(),
        },
    )
    .await
    .unwrap();
    sqlx::query("UPDATE agent_runs SET resolved_connection_id=$2 WHERE id=$1")
        .bind(run.id)
        .bind(connection)
        .execute(&f.pool)
        .await
        .unwrap();
    service.delete(&f.actor, connection).await.unwrap();
    assert!(
        preferences::get(&f.database, thread.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        runs::get(&f.database, &f.actor.workspace_id, run.id)
            .await
            .unwrap()
            .unwrap()
            .resolved_connection_id
            .is_none()
    );
}

#[tokio::test]
async fn agent_refresh_and_connection_deletion_use_the_same_workspace_run_lock_order() {
    let f = Fixture::new().await;
    let (service, _) = service(&f);
    let saved = service.create(&f.actor, input("personal")).await.unwrap();
    let connection = id(&saved);
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    sqlx::query("UPDATE agent_runs SET state='running',resolved_connection_id=$2 WHERE id=$1")
        .bind(run.id)
        .bind(connection)
        .execute(&f.pool)
        .await
        .unwrap();
    let actor = Actor {
        authentication: Authentication::Agent {
            run_id: run.id.to_string(),
            token_id: Uuid::new_v4().to_string(),
        },
        scopes: Some(vec![
            ApiScope::ModelConnectionsRead,
            ApiScope::ModelConnectionsWrite,
            ApiScope::AgentsWrite,
        ]),
        ..f.actor.clone()
    };
    let (refresh, delete) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            service.refresh(&actor, connection),
            service.delete(&actor, connection)
        )
    })
    .await
    .unwrap();
    delete.unwrap();
    if let Err(error) = refresh {
        assert!(
            matches!(
                error,
                StoreError::ModelConnection(policy::Error {
                    code: Code::ConnectionNotFound,
                    ..
                })
            ),
            "{error:?}"
        );
    }
    assert!(
        runs::get(&f.database, &f.actor.workspace_id, run.id)
            .await
            .unwrap()
            .unwrap()
            .resolved_connection_id
            .is_none()
    );
}

fn model_claims(f: &Fixture, run: Uuid, connection: Uuid) -> policy::ModelClaims {
    policy::ModelClaims {
        sub: f.actor.user_id.clone(),
        workspace_id: f.actor.workspace_id.clone(),
        run_id: run.to_string(),
        connection_id: connection.to_string(),
        provider: "openai".into(),
        model_id: "gpt-5".into(),
        token_id: Uuid::new_v4().to_string(),
    }
}
#[tokio::test]
async fn runtime_credentials_check_current_run_private_ownership_catalog_policy_and_staging() {
    let f = Fixture::new().await;
    let (mut service, _) = service(&f);
    let personal = service.create(&f.actor, input("personal")).await.unwrap();
    let shared = service.create(&f.actor, input("workspace")).await.unwrap();
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    sqlx::query("UPDATE agent_runs SET state='running' WHERE id=$1")
        .bind(run.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut claims = model_claims(&f, run.id, id(&personal));
    let flags = forge_core::agents::policy::features(&Default::default());
    let credential = service
        .runtime_credential(&claims, false, &flags)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(credential.api_key, "fixture-secret-1234");
    assert_eq!(credential.provider, "openai");
    assert!(
        service
            .runtime_credential(&claims, true, &flags)
            .await
            .unwrap()
            .is_none()
    );
    let mut blocked = flags.clone();
    blocked["agent_provider_openai"] = json!(false);
    assert!(
        service
            .runtime_credential(&claims, false, &blocked)
            .await
            .unwrap()
            .is_none()
    );
    service.allowed_providers = Some(Default::default());
    assert!(
        service
            .runtime_credential(&claims, false, &flags)
            .await
            .unwrap()
            .is_none()
    );
    service.allowed_providers = None;
    claims.model_id = "missing".into();
    assert!(
        service
            .runtime_credential(&claims, false, &flags)
            .await
            .unwrap()
            .is_none()
    );
    claims.model_id = "gpt-5".into();
    claims.provider = "anthropic".into();
    assert!(
        service
            .runtime_credential(&claims, false, &flags)
            .await
            .unwrap()
            .is_none()
    );
    claims.provider = "openai".into();
    sqlx::query("UPDATE model_catalog_entries SET status='hidden' WHERE connection_id=$1")
        .bind(id(&personal))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        service
            .runtime_credential(&claims, false, &flags)
            .await
            .unwrap()
            .is_none()
    );
    let mut other = Fixture::new().await;
    other.actor = enter_workspace(&f, &other).await;
    let other_thread = super::thread(&other).await;
    let other_run = super::run(&other, other_thread.id).await;
    sqlx::query("UPDATE agent_runs SET state='running' WHERE id=$1")
        .bind(other_run.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut foreign = model_claims(&other, other_run.id, id(&personal));
    assert!(
        service
            .runtime_credential(&foreign, false, &flags)
            .await
            .unwrap()
            .is_none()
    );
    foreign.connection_id = id(&shared).to_string();
    assert!(
        service
            .runtime_credential(&foreign, false, &flags)
            .await
            .unwrap()
            .is_some()
    );
    sqlx::query("UPDATE model_connections SET status='repair-required' WHERE id=$1")
        .bind(id(&shared))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        service
            .runtime_credential(&foreign, false, &flags)
            .await
            .unwrap()
            .is_none()
    );
    foreign.run_id = run.id.to_string();
    assert!(matches!(
        service.runtime_credential(&foreign, false, &flags).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn managed_runtime_credentials_still_require_an_active_run_and_live_membership() {
    let f = Fixture::new().await;
    let (mut service, _) = service(&f);
    service
        .managed_environment
        .insert("OPENAI_API_KEY".into(), "fixture-managed".into());
    service
        .managed_environment
        .insert("FORGE_MANAGED_OPENAI_MODELS".into(), "gpt-5".into());
    let thread = thread(&f).await;
    let run = run(&f, thread.id).await;
    let claims = model_claims(
        &f,
        run.id,
        policy::managed_id(&f.actor.workspace_id).parse().unwrap(),
    );
    let flags = forge_core::agents::policy::features(&Default::default());
    assert!(matches!(
        service.runtime_credential(&claims, false, &flags).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE agent_runs SET state='running' WHERE id=$1")
        .bind(run.id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        service
            .runtime_credential(&claims, true, &flags)
            .await
            .unwrap()
            .unwrap()
            .api_key,
        "fixture-managed"
    );
    sqlx::query("UPDATE agent_runs SET state='completed' WHERE id=$1")
        .bind(run.id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        service.runtime_credential(&claims, false, &flags).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE agent_runs SET state='waiting-for-approval' WHERE id=$1")
        .bind(run.id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        service
            .runtime_credential(&claims, false, &flags)
            .await
            .unwrap()
            .is_some()
    );
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        service.runtime_credential(&claims, true, &flags).await,
        Err(StoreError::Forbidden)
    ));
}

use super::loop_authority_acceptance::{callback, claimed};
use super::model_discovery as discovery;
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use forge_core::agents::providers::ModelClaims;
use forge_store::agents::model_connections::Service;
use std::sync::{Arc, atomic::Ordering};

#[tokio::test]
async fn loops_only_route_and_open_workspace_server_credentials_under_current_source_authority() {
    let f = Fixture::new().await;
    let team = issue_acceptance::team(&f, 119).await;
    let c = claimed(&f, team, json!({"kind":"manual"}), false).await;
    let provider = Arc::new(discovery::Provider::default());
    let vault =
        Arc::new(forge_identity::model_vault::Vault::new(&STANDARD.encode([7; 32])).unwrap());
    let service = Service::new(f.database.clone(), provider.clone(), vault);
    let input = |scope| json!({"provider":"openai","scope":scope,"displayName":"Loop model","apiKey":"fixture-secret-1234"});
    let allowed = service.create(&f.actor, input("workspace")).await.unwrap();
    let local = service.create(&f.actor, input("workspace")).await.unwrap();
    let external = service.create(&f.actor, input("workspace")).await.unwrap();
    let id = |v: &Value| v["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    // Ownership is immutable. Insert the adversarial personal fixture with its
    // synthetic owner from the outset, preserving all real database constraints.
    let personal_id = Uuid::new_v4();
    let reference = service
        .vault
        .seal(
            "fixture-secret-1234",
            &format!("{}:{personal_id}", f.actor.workspace_id),
        )
        .unwrap();
    sqlx::query("INSERT INTO model_connections SELECT (jsonb_populate_record(NULL::model_connections,to_jsonb(c)||jsonb_build_object('id',$2::uuid,'user_id',$3::text,'scope','personal','secret_reference',$4::text))).* FROM model_connections c WHERE c.id=$1")
        .bind(id(&allowed)).bind(personal_id).bind(&c.actor.user_id).bind(reference).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO model_catalog_entries SELECT (jsonb_populate_record(NULL::model_catalog_entries,to_jsonb(e)||jsonb_build_object('id',gen_random_uuid(),'connection_id',$2::uuid,'selection_id',$2::text||':'||e.provider_model_id))).* FROM model_catalog_entries e WHERE e.connection_id=$1")
        .bind(id(&allowed)).bind(personal_id).execute(&f.pool).await.unwrap();
    let personal = json!({"id":personal_id});
    sqlx::query("UPDATE model_connections SET locality='local-only' WHERE id=$1")
        .bind(id(&local))
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE model_connections SET execution_kind='external-agent' WHERE id=$1")
        .bind(id(&external))
        .execute(&f.pool)
        .await
        .unwrap();
    let agent = callback(&c);
    let visible = service.list(&agent).await.unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0]["id"], allowed["id"]);
    assert_eq!(service.catalog(&agent, false).await.unwrap().len(), 1);
    let calls = provider.calls.load(Ordering::SeqCst);
    service.refresh_for_routing(&agent, None).await.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), calls + 1);
    for blocked in [&personal, &local, &external] {
        assert!(
            service
                .refresh_for_routing(&agent, Some(id(blocked)))
                .await
                .is_err()
        );
    }
    assert!(matches!(
        service.create(&agent, input("workspace")).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        service.delete(&agent, id(&allowed)).await,
        Err(StoreError::Forbidden)
    ));
    let mut claims = ModelClaims {
        sub: agent.user_id.clone(),
        workspace_id: agent.workspace_id.clone(),
        run_id: c.agent_run.to_string(),
        connection_id: id(&allowed).to_string(),
        provider: "openai".into(),
        model_id: "gpt-5".into(),
        token_id: Uuid::new_v4().to_string(),
    };
    let flags = json!({"agent_provider_openai":true});
    assert_eq!(
        service
            .runtime_credential(&claims, false, &flags)
            .await
            .unwrap()
            .unwrap()
            .api_key,
        "fixture-secret-1234"
    );
    for blocked in [&personal, &local, &external] {
        claims.connection_id = id(blocked).to_string();
        assert!(
            service
                .runtime_credential(&claims, false, &flags)
                .await
                .unwrap()
                .is_none()
        );
    }
    claims.connection_id = id(&allowed).to_string();
    sqlx::query(
        "UPDATE model_catalog_entries SET execution_kind='external-agent' WHERE connection_id=$1",
    )
    .bind(id(&allowed))
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(service.catalog(&agent, false).await.unwrap().is_empty());
    assert!(
        service
            .runtime_credential(&claims, false, &flags)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query(
        "UPDATE model_catalog_entries SET execution_kind='forge-native' WHERE connection_id=$1",
    )
    .bind(id(&allowed))
    .execute(&f.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE team_loops SET enabled=false WHERE id=$1")
        .bind(c.definition)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        service.runtime_credential(&claims, false, &flags).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        service.catalog(&agent, false).await,
        Err(StoreError::Forbidden)
    ));
}

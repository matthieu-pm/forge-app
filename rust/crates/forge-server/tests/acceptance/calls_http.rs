use super::*;
#[tokio::test]
async fn call_http_binds_sessions_requires_consent_and_preserves_unicode_transcripts_and_retention()
{
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Calls HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    let forge_core::actor::Authentication::Session { session_id } = &actor.authentication else {
        panic!()
    };
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Calls","identifier":"CAL","timezone":"UTC","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"}})).unwrap()).await.unwrap();
    let mut input = json!({"workspaceId":actor.workspace_id,"sessionId":session_id,"teamId":team.id,
        "title":" Review ","startedAt":forge_core::loops::iso_timestamp(chrono::Utc::now()-chrono::Duration::days(10)),
        "text":format!("Alex: {}\nSam: Follow up.","語".repeat(20000)),"consentConfirmed":false});
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/calls/import",
            Some(&cookie),
            Some(input.clone())
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    input["consentConfirmed"] = json!(true);
    let mut wrong = input.clone();
    wrong["sessionId"] = json!("wrong-session");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/calls/import",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, _, id) = f
        .request(
            "POST",
            "/api/workspace/calls/import",
            Some(&cookie),
            Some(input),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{id}");
    assert!(id.as_str().is_some());
    let base = json!({"workspaceId":actor.workspace_id,"sessionId":session_id});
    let (status, _, directory) = f
        .request(
            "POST",
            "/api/workspace/calls",
            Some(&cookie),
            Some(base.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{directory}");
    assert_eq!(directory["calls"][0]["transcript"], json!([]));
    let mut read = base.clone();
    read["callId"] = id.clone();
    let (status, _, record) = f
        .request(
            "POST",
            "/api/workspace/calls/read",
            Some(&cookie),
            Some(read.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{record}");
    assert_eq!(
        record["transcript"][0]["text"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        20000
    );
    let mut note = read.clone();
    note["body"] = json!("  Team note  ");
    note["kind"] = json!("note");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/calls/notes",
            Some(&cookie),
            Some(note)
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut retention = base.clone();
    retention["days"] = json!(7);
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/calls/retention",
            Some(&cookie),
            Some(retention)
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, _, record) = f
        .request(
            "POST",
            "/api/workspace/calls/read",
            Some(&cookie),
            Some(read.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{record}");
    assert_eq!(record["status"], "expired");
    assert_eq!(record["transcript"], json!([]));
    assert_eq!(record["notes"][0]["body"], "Team note");
    assert_eq!(
        f.request("POST", "/api/workspace/calls/read", None, Some(read))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

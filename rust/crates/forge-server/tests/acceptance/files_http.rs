use super::*;
use forge_server::files::storage::Storage;
struct Directory(std::path::PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn setup() -> (Fixture, Directory, String, forge_core::actor::Actor) {
    let mut f = Fixture::new().await;
    let dir = Directory(std::env::temp_dir().join(format!("forge-files-http-{}", Uuid::new_v4())));
    let state = AppState::configured_database(
        f.database.clone(),
        AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
        Some(f.mailbox.clone()),
    )
    .with_files(Storage::local(&dir.0).unwrap(), SECRET.into());
    f.app = forge_server::router_with_state(state);
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "File HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    (f, dir, cookie, actor)
}
fn input(name: &str, bytes: &[u8]) -> Value {
    json!({"commandKey":Uuid::new_v4(),"target":{"kind":"agent"},"name":name,"contentType":"text/plain","sizeBytes":bytes.len(),"checksum":forge_core::files::checksum(bytes)})
}
async fn raw(
    f: &Fixture,
    method: &str,
    path: &str,
    cookie: &str,
    headers: &[(&str, &str)],
    body: Body,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("cookie", cookie);
    for (k, v) in headers {
        request = request.header(*k, *v)
    }
    let response = f
        .app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, bytes.to_vec())
}
async fn ready(f: &Fixture, cookie: &str, name: &str, bytes: &[u8]) -> Value {
    let (s, _, intent) = f
        .request(
            "POST",
            "/api/files/uploads",
            Some(cookie),
            Some(input(name, bytes)),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{intent}");
    let id = intent["id"].as_str().unwrap();
    let (s, _, token) = f
        .request(
            "POST",
            &format!("/api/files/uploads/{id}/token"),
            Some(cookie),
            Some(json!({})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{token}");
    let (s, _, body) = raw(
        f,
        "PUT",
        token["upload"]["url"].as_str().unwrap(),
        cookie,
        &[("origin", ORIGIN)],
        Body::from(bytes.to_vec()),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let (s, _, result) = f
        .request(
            "POST",
            &format!("/api/files/uploads/{id}/finalize"),
            Some(cookie),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{result}");
    assert_eq!(result["id"], intent["id"]);
    result
}
#[tokio::test]
async fn files_http_uploads_large_bytes_replays_finalize_and_delivers_inert_previews() {
    let (f, _dir, cookie, a) = setup().await;
    let bytes = vec![65; 5 * 1024 * 1024];
    let file = ready(&f, &cookie, "large.txt", &bytes).await;
    let id = file["id"].as_str().unwrap();
    let path = format!("/api/files/attachments/{id}/grant");
    let (s, _, denied) = f
        .request(
            "POST",
            &path,
            Some(&cookie),
            Some(json!({"purpose":"preview"})),
        )
        .await;
    assert_eq!(s, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{denied}");
    let (s, _, grant) = f
        .request(
            "POST",
            &path,
            Some(&cookie),
            Some(json!({"purpose":"download"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{grant}");
    assert!(!grant.to_string().contains("storageReference"));
    let (s, h, download) = raw(
        &f,
        "GET",
        grant["url"].as_str().unwrap(),
        &cookie,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(download, bytes);
    assert_eq!(h["content-type"], "application/octet-stream");
    assert_eq!(h["cache-control"], "private, no-store, max-age=0");
    assert!(
        h["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );
    let (s, _, again) = f
        .request(
            "POST",
            &format!("/api/files/uploads/{id}/finalize"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(again, file);
    let hostile=b"<h1>Readable</h1><script>parent.pwned=true</script><p onclick='a()'>safe</p><img src='https://evil.test/leak'>";
    let html = ready(&f, &cookie, "hostile.html", hostile).await;
    let (s, _, preview) = f
        .request(
            "POST",
            &format!(
                "/api/files/attachments/{}/grant",
                html["id"].as_str().unwrap()
            ),
            Some(&cookie),
            Some(json!({"purpose":"preview"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{preview}");
    let (s, h, body) = raw(
        &f,
        "GET",
        preview["url"].as_str().unwrap(),
        &cookie,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let html = String::from_utf8(body).unwrap();
    assert!(html.contains("<h1>Readable</h1>"));
    for bad in ["<script", "onclick", "evil.test"] {
        assert!(!html.contains(bad));
    }
    let csp = h["content-security-policy"].to_str().unwrap();
    assert!(csp.contains("sandbox;"));
    assert!(!csp.contains("allow-scripts"));
    assert!(!csp.contains("allow-same-origin"));
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&a.workspace_id)
        .bind(&a.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let (s, _, body) = raw(
        &f,
        "GET",
        grant["url"].as_str().unwrap(),
        &cookie,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(
        s,
        StatusCode::NOT_FOUND,
        "{}",
        String::from_utf8_lossy(&body)
    );
}
#[tokio::test]
async fn files_http_bounds_metadata_binds_session_context_and_preserves_upload_retry_states() {
    let (f, _dir, cookie, a) = setup().await;
    let target = "/api/files/uploads";
    for headers in [
        vec![],
        vec![("origin", "http://evil.test")],
        vec![
            ("origin", ORIGIN),
            ("x-forge-upload-session", "wrong"),
            ("x-forge-upload-workspace", a.workspace_id.as_str()),
        ],
    ] {
        let (s, _, _) = raw(
            &f,
            "POST",
            target,
            &cookie,
            &headers,
            Body::from(input("x", b"hello").to_string()),
        )
        .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    let (s, _, body) = raw(
        &f,
        "POST",
        target,
        &cookie,
        &[("origin", ORIGIN)],
        Body::from(vec![65; 8193]),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(String::from_utf8(body).unwrap().contains("8192"));
    let (s, _, intent) = f
        .request(
            "POST",
            target,
            Some(&cookie),
            Some(input("x.txt", b"hello")),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{intent}");
    let id = intent["id"].as_str().unwrap();
    let bytes = format!("{target}/{id}/bytes");
    let (s, _, _) = raw(
        &f,
        "PUT",
        &bytes,
        &cookie,
        &[("origin", ORIGIN)],
        Body::from("hello"),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _, missing) = f
        .request(
            "POST",
            &format!("{target}/{id}/finalize"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(missing["error"]["code"], "UPLOAD_UNAVAILABLE");
    let (s, _, _) = f
        .request(
            "POST",
            &format!("{target}/{id}/token"),
            Some(&cookie),
            Some(json!({"storageReference":"arbitrary"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    for _ in 0..5 {
        assert_eq!(
            f.request("POST", &format!("{target}/{id}/token"), Some(&cookie), None)
                .await
                .0,
            StatusCode::OK
        );
    }
    let (s, h, _) = f
        .request("POST", &format!("{target}/{id}/token"), Some(&cookie), None)
        .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert!(h.contains_key("retry-after"));
    let (s, _, _) = raw(
        &f,
        "PUT",
        &bytes,
        &cookie,
        &[("origin", ORIGIN)],
        Body::from("wrong"),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, bad) = f
        .request(
            "POST",
            &format!("{target}/{id}/finalize"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(bad["error"]["code"], "INVALID_UPLOAD");
    let state: String = sqlx::query_scalar("SELECT state FROM file_upload_intents WHERE id=$1")
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(state, "rejected");
    let path = format!("/api/files/attachments/{id}/grant");
    let (s, _, _) = raw(
        &f,
        "POST",
        &path,
        &cookie,
        &[],
        Body::from("{\"purpose\":\"download\"}"),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _, _) = f
        .request(
            "POST",
            &path,
            Some(&cookie),
            Some(json!({"purpose":"download","extra":true})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

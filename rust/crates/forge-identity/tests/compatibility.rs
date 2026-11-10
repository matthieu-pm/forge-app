use forge_identity::{
    bearer_credential, hash_password, session_token_from_cookies, sign_session_token,
    verify_password, verify_session_token,
};
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap()
}

#[test]
fn accepts_existing_better_auth_passwords_with_unicode_normalization() {
    let fixture = fixtures();
    let case = &fixture["crypto"]["password"];
    let hash = case["hash"].as_str().unwrap();
    assert!(verify_password(case["password"].as_str().unwrap(), hash));
    assert!(verify_password(case["normalized"].as_str().unwrap(), hash));
    assert!(!verify_password("wrong-password", hash));
    assert!(!verify_password("password", "malformed"));
}

#[test]
fn new_password_hashes_are_salted_and_verifiable() {
    let first = hash_password("local-test-password").unwrap();
    let second = hash_password("local-test-password").unwrap();
    assert_ne!(first, second);
    assert!(verify_password("local-test-password", &first));
    assert!(verify_password("local-test-password", &second));
}

#[test]
fn cookie_signatures_match_better_call_in_both_directions() {
    let fixture = fixtures();
    for case in fixture["crypto"]["cookies"].as_array().unwrap() {
        let token = case["token"].as_str().unwrap();
        let secret = case["secret"].as_str().unwrap();
        let signed = case["signed"].as_str().unwrap();
        assert_eq!(sign_session_token(token, secret).unwrap(), signed);
        assert_eq!(verify_session_token(signed, secret).unwrap(), token);
        assert!(verify_session_token(signed, "wrong-secret").is_err());
        assert!(verify_session_token(token, secret).is_err());
        let cookie = format!("other=value; __Secure-better-auth.session_token={signed}");
        assert_eq!(
            session_token_from_cookies(&cookie, true, secret).unwrap(),
            token
        );
        assert!(session_token_from_cookies(&cookie, false, secret).is_err());
        let duplicate =
            format!("better-auth.session_token={signed}; better-auth.session_token={signed}");
        assert!(session_token_from_cookies(&duplicate, false, secret).is_err());
    }
}

#[test]
fn bearer_parser_accepts_only_one_complete_credential() {
    assert_eq!(bearer_credential("Bearer forge_test"), Some("forge_test"));
    assert_eq!(bearer_credential("bearer\tforge_test"), Some("forge_test"));
    for invalid in [
        "forge_test",
        "Basic forge_test",
        "Bearer",
        "Bearer ",
        "Bearer one two",
        "Bearer token ",
    ] {
        assert_eq!(bearer_credential(invalid), None, "{invalid}");
    }
}

#[test]
fn verification_jwt_matches_the_installed_authentication_library() {
    use forge_identity::{email_verification_token, verify_email_token};
    let fixture = fixtures();
    let case = &fixture["crypto"]["jwt"];
    let token = case["token"].as_str().unwrap();
    let secret = case["secret"].as_str().unwrap();
    let now = case["now"].as_i64().unwrap();
    assert_eq!(
        email_verification_token(case["email"].as_str().unwrap(), secret, now).unwrap(),
        token
    );
    assert_eq!(
        verify_email_token(token, secret, now).unwrap().email,
        "test@example.test"
    );
    assert!(verify_email_token(token, secret, now + 3600).is_err());
    assert!(verify_email_token(token, "wrong-secret", now).is_err());
}

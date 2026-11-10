use forge_recovery::{JournalConfig, R2Journal};

fn configuration() -> JournalConfig {
    JournalConfig {
        account_id: "a".repeat(32),
        bucket: "forge-recovery-deletion-journal".into(),
        access_key_id: "b".repeat(32),
        secret_access_key: "c".repeat(40),
        signing_key: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=".into(),
    }
}

#[tokio::test]
async fn constructs_an_explicitly_credentialed_client_without_network_access() {
    assert!(R2Journal::new(configuration()).is_ok());
}

#[test]
fn rejects_malformed_credentials_and_unrelated_buckets() {
    let mut config = configuration();
    config.bucket = "another-bucket".into();
    assert!(R2Journal::new(config).is_err());
    let mut config = configuration();
    config.account_id = "not-an-account".into();
    assert!(R2Journal::new(config).is_err());
    let mut config = configuration();
    config.signing_key = "malformed".into();
    assert!(R2Journal::new(config).is_err());
}

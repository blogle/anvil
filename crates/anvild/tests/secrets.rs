use anvild::secrets::{SecretBox, SecretError, BLOB_PREFIX};

fn key(n: u8) -> [u8; 32] {
    [n; 32]
}

#[test]
fn sealed_blobs_roundtrip_and_are_not_the_plaintext() {
    let box_ = SecretBox::from_key(key(1));
    let blob = box_.seal("ghp-super-secret-token").unwrap();
    assert!(blob.starts_with(BLOB_PREFIX));
    assert!(!blob.contains("ghp-super-secret"));
    assert_eq!(
        box_.open(&blob).unwrap().as_deref(),
        Some("ghp-super-secret-token")
    );
}

#[test]
fn each_seal_uses_a_fresh_nonce() {
    let box_ = SecretBox::from_key(key(2));
    let a = box_.seal("same plaintext").unwrap();
    let b = box_.seal("same plaintext").unwrap();
    assert_ne!(a, b);
    assert_eq!(box_.open(&a).unwrap(), box_.open(&b).unwrap());
}

#[test]
fn a_wrong_master_key_cannot_open_a_blob() {
    let sealer = SecretBox::from_key(key(3));
    let other = SecretBox::from_key(key(4));
    let blob = sealer.seal("private").unwrap();
    assert!(matches!(other.open(&blob), Err(SecretError::WrongKey)));
}

#[test]
fn tampered_blobs_fail_explicitly() {
    let box_ = SecretBox::from_key(key(5));
    let blob = box_.seal("private").unwrap();
    let tampered = format!("{blob}00");
    assert!(matches!(box_.open(&tampered), Err(SecretError::WrongKey)));
}

#[test]
fn legacy_plaintext_rows_read_as_themselves() {
    let box_ = SecretBox::from_key(key(6));
    assert_eq!(box_.open("written-before-encryption").unwrap(), None);
}

#[tokio::test]
async fn the_store_file_holds_no_plaintext_and_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("anvil.db");
    let store = anvild::store::Store::open(&db).await.unwrap();
    store
        .put_credential(
            "github-app-private-key",
            "-----BEGIN RSA PRIVATE KEY-----\nabc\n",
        )
        .await
        .unwrap();
    drop(store);

    let raw = std::fs::read(&db).unwrap();
    assert!(
        !String::from_utf8_lossy(&raw).contains("BEGIN RSA PRIVATE KEY"),
        "the database must not hold the secret in the clear"
    );

    let reopened = anvild::store::Store::open(&db).await.unwrap();
    let secret = reopened
        .credential("github-app-private-key")
        .await
        .unwrap()
        .expect("credential exists");
    assert!(secret.starts_with("-----BEGIN RSA PRIVATE KEY-----"));

    let key_file = dir.path().join("secret.key");
    assert!(key_file.exists());
    let metadata = std::fs::metadata(&key_file).unwrap();
    #[cfg(unix)]
    let perms = std::os::unix::fs::PermissionsExt::mode(&metadata.permissions());
    #[cfg(unix)]
    assert_eq!(perms & 0o777, 0o600);
}

#[tokio::test]
async fn a_wrong_master_key_file_reads_as_an_explicit_error() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("secret.key"), "not-hex-at-all").unwrap();
    let db = dir.path().join("anvil.db");
    let outcome = anvild::store::Store::open(&db).await;
    let error = match outcome {
        Ok(_) => panic!("a bad key file must not open the store"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("64 hex characters"), "{error}");
}

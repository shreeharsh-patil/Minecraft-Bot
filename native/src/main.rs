#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    minecraft_companion::minecraft::run().await
}

#[allow(dead_code)]
mod verify_only {
    // Compile-time smoke checks for dependencies that are only used by the
    // native backend. They prevent us from accidentally removing an import
    // that the real client path relies on.
    use azalea_crypto::keys::CryptoKeyStore;
    use parking_lot::Mutex;
    use rsa::RsaPrivateKey;
    use sha2::{Digest, Sha256};
    use tokio::signal;
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
    use uuid::Uuid;

    fn _crypto_key_store_compile_guard() {
        let _store: CryptoKeyStore = CryptoKeyStore::new();
    }

    fn _rsa_compile_guard() {
        let key = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).expect("smoke");
        let _p = key.to_public_key();
    }

    fn _sha2_compile_guard() {
        let mut hasher = Sha256::new();
        hasher.update(b"smoke");
        let _d = hasher.finalize();
    }

    fn _uuid_compile_guard() {
        let _id = Uuid::new_v4();
    }

    fn _mutex_compile_guard() {
        let _m = Mutex::new(0u32);
    }

    async fn _signal_compile_guard() {
        let _ = signal::ctrl_c();
    }

    fn _tracing_compile_guard() {
        let _ = tracing_subscriber::registry();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn smoke_links_compile() {
        _crypto_key_store_compile_guard();
        _rsa_compile_guard();
        _sha2_compile_guard();
        _uuid_compile_guard();
        _mutex_compile_guard();
        _signal_compile_guard().await;
        _tracing_compile_guard();
    }
}

use azalea::{auth::certs::Certificates, buf::AzaleaWrite};
use minecraft_companion::minecraft::signing::SigningSession;
use rsa::{pkcs8::EncodePublicKey, signature::Verifier, RsaPrivateKey};
#[test]
fn signed_chat_envelope_binds_session_body_and_seen_messages() {
    let private_key = RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
    let public_key = private_key.to_public_key();
    let account = uuid::Uuid::new_v4();
    let certs = Certificates {
        public_key_der: public_key.to_public_key_der().unwrap().to_vec(),
        private_key,
        signature_v1: vec![],
        signature_v2: vec![],
        expires_at: chrono::DateTime::<chrono::Utc>::from_timestamp(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
            0,
        )
        .unwrap()
            + chrono::Duration::hours(1),
        refresh_after: chrono::DateTime::<chrono::Utc>::from_timestamp(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
            0,
        )
        .unwrap()
            + chrono::Duration::minutes(30),
    };
    let mut session = SigningSession::new(account, certs);
    let init = session.initialize().unwrap();
    assert!(session.initialize().is_none());
    let seen = azalea_crypto::MessageSignature { bytes: [42; 256] };
    session.observe(&seen);
    let packet = session.sign("Ready to follow.".into()).unwrap();
    let mut data = Vec::new();
    1i32.azalea_write(&mut data).unwrap();
    account.azalea_write(&mut data).unwrap();
    init.chat_session
        .session_id
        .azalea_write(&mut data)
        .unwrap();
    0u32.azalea_write(&mut data).unwrap();
    packet.salt.azalea_write(&mut data).unwrap();
    (packet.timestamp / 1000).azalea_write(&mut data).unwrap();
    (packet.message.len() as u32)
        .azalea_write(&mut data)
        .unwrap();
    data.extend_from_slice(packet.message.as_bytes());
    1u32.azalea_write(&mut data).unwrap();
    data.extend_from_slice(&seen.bytes);
    let signature =
        rsa::pkcs1v15::Signature::try_from(packet.signature.unwrap().bytes.as_slice()).unwrap();
    let verifier = rsa::pkcs1v15::VerifyingKey::<sha2::Sha256>::new(public_key);
    verifier.verify(&data, &signature).unwrap();
    data.push(0);
    assert!(verifier.verify(&data, &signature).is_err());
    assert_eq!(packet.last_seen_messages.messages, 1);
    for i in 0..70 {
        session.observe(&azalea_crypto::MessageSignature { bytes: [i; 256] });
    }
    assert!(session.pending_ack().is_some());
    assert!(session.pending_ack().is_none());
}

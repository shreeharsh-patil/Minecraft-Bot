//! Protocol-769 chat signing. The signature envelope follows the pinned
//! azalea-crypto signing source, extended with its missing last-seen signatures.
use azalea::{
    auth::certs::Certificates,
    buf::AzaleaWrite,
    core::bitset::FixedBitSet,
    protocol::packets::game::{
        s_chat::{LastSeenMessagesUpdate, ServerboundChat},
        s_chat_session_update::{
            ProfilePublicKeyData, RemoteChatSessionData, ServerboundChatSessionUpdate,
        },
    },
};
use azalea_crypto::MessageSignature;
use rsa::signature::{RandomizedSigner, SignatureEncoding};
use std::{
    collections::VecDeque,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub struct SigningSession {
    account: Uuid,
    session: Uuid,
    index: u32,
    certs: Certificates,
    last_seen: VecDeque<MessageSignature>,
    offset: u32,
    initialized: bool,
}
impl SigningSession {
    pub fn new(account: Uuid, certs: Certificates) -> Self {
        Self {
            account,
            session: Uuid::new_v4(),
            index: 0,
            certs,
            last_seen: VecDeque::with_capacity(20),
            offset: 0,
            initialized: false,
        }
    }
    pub fn observe(&mut self, signature: &MessageSignature) {
        if self.last_seen.back() == Some(signature) {
            return;
        }
        if self.last_seen.len() == 20 {
            self.last_seen.pop_front();
        }
        self.last_seen.push_back(signature.clone());
        self.offset += 1;
    }
    pub fn initialize(&mut self) -> Option<ServerboundChatSessionUpdate> {
        if self.initialized {
            return None;
        }
        self.initialized = true;
        Some(ServerboundChatSessionUpdate {
            chat_session: RemoteChatSessionData {
                session_id: self.session,
                profile_public_key: ProfilePublicKeyData {
                    expires_at: self.certs.expires_at.timestamp_millis() as u64,
                    key: self.certs.public_key_der.clone(),
                    key_signature: self.certs.signature_v2.clone(),
                },
            },
        })
    }
    pub fn pending_ack(
        &mut self,
    ) -> Option<azalea::protocol::packets::game::s_chat_ack::ServerboundChatAck> {
        if self.offset >= 64 {
            Some(
                azalea::protocol::packets::game::s_chat_ack::ServerboundChatAck {
                    messages: std::mem::take(&mut self.offset),
                },
            )
        } else {
            None
        }
    }
    pub fn sign(&mut self, message: String) -> Result<ServerboundChat, String> {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "invalid system time")?;
        if time.as_millis() >= self.certs.expires_at.timestamp_millis() as u128 {
            return Err("chat certificate expired; reauthenticate manually".into());
        }
        let salt = azalea_crypto::make_salt();
        let mut data = Vec::new();
        1i32.azalea_write(&mut data)
            .map_err(|_| "signature encoding")?;
        self.account
            .azalea_write(&mut data)
            .map_err(|_| "signature encoding")?;
        self.session
            .azalea_write(&mut data)
            .map_err(|_| "signature encoding")?;
        self.index
            .azalea_write(&mut data)
            .map_err(|_| "signature encoding")?;
        salt.azalea_write(&mut data)
            .map_err(|_| "signature encoding")?;
        time.as_secs()
            .azalea_write(&mut data)
            .map_err(|_| "signature encoding")?;
        (message.len() as u32)
            .azalea_write(&mut data)
            .map_err(|_| "signature encoding")?;
        data.extend_from_slice(message.as_bytes());
        (self.last_seen.len() as u32)
            .azalea_write(&mut data)
            .map_err(|_| "signature encoding")?;
        for seen in &self.last_seen {
            data.extend_from_slice(&seen.bytes);
        }
        let signing_key =
            rsa::pkcs1v15::SigningKey::<sha2::Sha256>::new(self.certs.private_key.clone());
        let signature = signing_key
            .sign_with_rng(&mut rand::thread_rng(), &data)
            .to_bytes();
        let bytes = signature
            .as_ref()
            .try_into()
            .map_err(|_| "invalid signature length")?;
        let mut acknowledged = FixedBitSet::<3>::new();
        let start = 20 - self.last_seen.len();
        for index in start..20 {
            acknowledged.set(index);
        }
        let offset = std::mem::take(&mut self.offset);
        self.index += 1;
        Ok(ServerboundChat {
            message,
            timestamp: time.as_millis() as u64,
            salt,
            signature: Some(MessageSignature { bytes }),
            last_seen_messages: LastSeenMessagesUpdate {
                messages: offset,
                acknowledged,
            },
        })
    }
}

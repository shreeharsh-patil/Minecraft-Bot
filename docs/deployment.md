# Deployment and zero-cost hosting

The runtime needs outbound Minecraft TCP, HTTPS for optional authentication/AI, and private writable state. It exposes no public HTTP endpoint. No provider account, cloud project, credit card or billable resource was created.

## Local and Linux VPS

Run the release executable with `.env` and `data/` owned by its service account. The included systemd unit uses manual/external activation and `Restart=no`. Install it under `/opt/minecraft-companion`, protect `.env` with mode 0600, and only grant the configured owner access to the activation file. Ordinary hosting may cost money; local/Raspberry Pi hardware uses electricity and existing connectivity.

Use `--activation-file data/activation.json` only with a trustworthy external presence signal. The supervisor reads owner-controlled JSON:

```json
{"active":true,"authorized_players":["Shreeharsh"],"expires_unix":1791820000,"session_id":"37369fd1-d343-4efe-8b5b-5298e08bb325"}
```

Set a real expiry no more than 120 seconds in the future and renew it while real authorized humans are confirmed online. Keep the same session_id during one human gameplay session; generate a new ID only for a fresh legitimate session. An expired, inactive, malformed, writable-by-others Unix file, or one with no allowlisted player is rejected. Renewal of the same ID cannot repeatedly activate an ended bot session. Never derive exact identity from incomplete server-ping samples. If you cannot produce a trustworthy signal, use the local console `join` instead.

## Docker

```sh
docker build -t minecraft-companion .
docker run --rm -it --env-file .env -v companion-data:/app/data minecraft-companion
```

The multi-stage image compiles Rust in Debian and copies only the release executable into a Debian slim runtime with CA certificates. It runs as UID 10001 and handles SIGTERM. The allowlist Docker context includes only Rust source, manifests and build configuration, so `.env`, TypeScript/node_modules and auth state are excluded. For external activation, mount an owner-controlled activation directory/file with permissions readable by UID 10001. Keep authentication in the private data volume. Do not configure a restart policy to recreate sessions after Aternos disconnects.

The local Docker engine did not respond during this run, so this image has not been built or run here. The supplied CI container job is a finite verification step and still needs a successful run. The Windows executable does not establish Linux/container or ARM64 compatibility by itself.

Build on ARM64 Linux/Pi with `cargo build --release --locked`, or use `docker buildx build --platform linux/arm64` with an ARM64 build runner/emulator. Hardware behavior and image builds are not presumed verified by a Windows binary build.

## Researched free-provider constraints

Official documentation checked 2026-10-12. None of the reviewed providers was verified as satisfying **all** requirements: no credit card, no trial credits, persistent arbitrary outbound TCP worker, durable private auth cache and reliable background availability.

| Provider | Documented restriction | Assessment |
|---|---|---|
| Render free web service | Sleeps after 15 minutes without inbound traffic; no persistent disks; can suspend high service-initiated traffic | Not a reliable Minecraft background-worker deployment. Outbound Minecraft traffic does not meet its inbound wake condition. [Free services](https://render.com/docs/free) |
| Koyeb free instance | Free web-service instance, 512 MB / 0.1 vCPU, scales down after one hour without traffic; billing/verification rules apply | Not verified as an uninterrupted TCP worker. Do not fake inbound traffic to claim availability. [Instances](https://www.koyeb.com/docs/reference/instances), [pricing FAQ](https://www.koyeb.com/docs/faqs/pricing) |
| Oracle Cloud Always Free | Sign-up requires credit/debit card verification; trial resources are separate from Always Free | Does not meet the no-card requirement. [Official FAQ](https://www.oracle.com/cloud/free/faq/) |
| Fly.io | No free tier for new organizations; no-card trial ends after 2 hours runtime or 7 days | Does not meet recurring zero-cost/no-trial requirements. [Pricing](https://docs.fly.io/about/pricing) |

Local hardware is the currently supportable deployment without a hosting plan or trial credits. Sleeping/free service instances cannot be advertised as always available. GitHub Actions is used only for finite builds/tests and artifact uploads, never as hosting.

# Dependency review

The historical framework's upstream lockfile was inspected against the RustSec advisory database on 2026-10-13. Compatible patches were selected explicitly rather than assuming a 2025 lockfile was safe today:

| Package | Previous version | Selected patch | Advisory |
|---|---|---|---|
| bytes | 1.10.0 | 1.11.1 | [RUSTSEC-2026-0007](https://rustsec.org/advisories/RUSTSEC-2026-0007.html) |
| crossbeam-channel | 0.5.14 | 0.5.15 | [RUSTSEC-2025-0024](https://rustsec.org/advisories/RUSTSEC-2025-0024.html) |
| ring | 0.17.9 | 0.17.12 | [RUSTSEC-2025-0009](https://rustsec.org/advisories/RUSTSEC-2025-0009.html) |
| tracing-subscriber | 0.3.19 | 0.3.20 | [RUSTSEC-2025-0055](https://rustsec.org/advisories/RUSTSEC-2025-0055.html) |
| rustls | 0.23.23 | 0.23.45 | [RUSTSEC-2026-0285](https://rustsec.org/advisories/RUSTSEC-2026-0285.html) |
| rustls-webpki | 0.102.8 | 0.103.15 through rustls | Certificate-validation patches in the current compatible release |

The lockfile also includes optional QUIC dependencies even though HTTP/3 is not enabled. `quinn-proto` was selected for a compatible 0.11.18 update; verify its recorded version in Cargo.lock and its advisory status when changing Reqwest features.

Two upstream gates remain:

- `hickory-proto 0.24.3` is held by the 1.21.4 protocol framework's resolver API. [RUSTSEC-2026-0119](https://rustsec.org/advisories/RUSTSEC-2026-0119.html) concerns quadratic DNS-message encoding, with a patch in 0.26.1. Replacing that resolver requires a framework/API change or a reviewed backport. The normal client encodes small bounded hostname queries; this is a scope observation, not a clean audit result.
- `rsa 0.9.7` has [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html), and RustSec lists no patched version. The bot does RSA public-key encryption and private-key chat signing, not a server offering private-key decryption. The signing path uses randomized blinding, but full cryptographic threat assessment and online-mode validation remain release gates.

This was a package/advisory review, not a passing `cargo audit` attestation, exploit assessment or complete security certification. Original TypeScript dependencies were retained for comparison; no claim is made that they are vulnerability-free.

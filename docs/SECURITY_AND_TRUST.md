# Security and Trust Model

## 1. Boundary

Launch as a standalone Shadownet game. Dos Esposas names and ingredient classes
are semantic references only. DER and foreign assets remain absent or read-only
until full identity and policy verification.

## 2. Launch blockers

### Asset identity

Maintain a reviewed registry keyed by chain, contract, and token ID. Pin code,
standard, decimals, metadata policy, privileged roles, supply authority,
custody, and intended use. Reject user-supplied contracts and ambiguity.

### Wallet drift

Capture and revalidate wallet runtime generation, session revision, source
account, chain ID, permission scope, destination, entrypoint, attached mutez
amount, canonical payload bytes, manifest hash, intent ID, and expiry at final
wallet dispatch with no intervening await. Reconnect/disconnect invalidates older
wallet runtime generations. Invalid drift must result in zero dispatch.

### Deployment identity

After origination, generate a typed canonical deployment manifest. The MVP
receipt manifest contains chain, operation, address, privileged roles, issuer
key, code/schema/entrypoints, initial empty nonce/record state, and receipt
policy. Future FA2/kitchen manifests separately contain ledger/supply, metadata,
economic policy, interoperability registry, and randomness where applicable.
Runtime readiness reconstructs indexed origination and current privilege
evidence; a configured digest alone is insufficient.

### Transaction truth

Track intent plus operation hash through awaiting signature, submitted,
included, confirmed/finalized, failed, dropped, replaced, and reorged states.
Only confirmed events change chain-authoritative projections. Retry is
idempotent and receipts bind all identity and policy fields.

### Admin power

Separate deployer, pause guardian, metadata curator, treasury, and economic
governance. Production uses hardware-backed multisig and timelocked public
policy changes. No unilateral arbitrary mint, seizure, recipe rewrite, foreign
target rewrite, or confiscating pause.

### Metadata and media

Use content-addressed assets where possible. Treat names/descriptions as
untrusted text. Media fetching must deny private networks, bound redirects,
timeouts, bytes, decompression, and MIME, and quarantine/transcode active
formats. Never render arbitrary HTML/SVG/script media on the app origin. Enforce
CSP and safe outbound links.

### Contract integrity

Require bounded inputs, exact raw-unit math, known identities, nonnegative
balances, atomic failure, idempotency, and explicit disposition. Production
artifacts exclude faucet/test mint. Operator approval scope is minimized and
explained.

### Public-chain privacy

The player receives an explicit pre-signature disclosure that the wallet
account, content version, nonce, opaque commitment, payload hash, operation, and
chain timestamps are public and cannot be deleted. The commitment MUST NOT be a
database service ID. It is salted with 256 bits of server randomness before
hashing the private service digest, preventing enumeration and ordinary
correlation. No guest ID, order history, score, dialogue, accessibility setting,
analytics ID, or other behavior is included.

Offchain deletion removes the private service record, salt, guest/wallet link,
and analytics join under the documented retention policy; the public opaque
record remains and cannot be reversed. The server retains only the minimum
issuer/nonce audit needed for security, with a published duration. Optional
public summaries require separate opt-in and warn that content addressing does
not guarantee availability.

Issuer permits are domain-separated, expiring, single-use, and bound to account,
chain, destination, entrypoint, zero mutez, commitment, content/manifest
versions, and nonce. Issuer-key rotation/revocation is multisig-controlled,
manifest-bound, monitored, and rehearsed for compromise; it cannot issue a
second record for an existing uniqueness key.

### Randomness

MVP has no economic randomness. Any future transferable random reward requires
an independently audited VRF/oracle or commit-reveal design covering domain
separation, deadlines, anti-withholding, retry/refund, reorg, replay, and
exactly-once settlement.

## 3. Threats and mitigations

| Threat | Required mitigation |
| --- | --- |
| lookalike DER/RICE token | exact allowlist and negative identity tests |
| account/network change during request | final-dispatch revision guard; zero stale send |
| optimistic false success | explicit lifecycle; confirmation threshold; durable receipt |
| duplicate click/event/replay | intent ID, contract nonce, DB uniqueness, idempotent worker |
| stale or malicious indexer | schema validation, RPC reconciliation, freshness, fail closed |
| false deployment config | reconstruct origination and privileged state from chain evidence |
| hostile media/metadata | proxy isolation, hashes, MIME/size limits, CSP, sanitization |
| compromised admin | least privilege, multisig, timelock, alerts, recovery ceremony |
| test capability in production | separate artifact plus forbidden-entrypoint CI |
| wallet-address privacy leak | data minimization, purpose limitation, retention/deletion policy |

## 4. Security gates

- Contract: reproducible build, bytecode match, unit/property/fuzz/invariant and
  callback/boundary tests, no rehearsal entrypoints, independent review with no
  unresolved critical/high issues.
- Wallet: real SDK concurrency tests for account/network/scope/session drift,
  reconnect overlap, multi-tab state, mapping delay, duplicate click, rejection,
  timeout, and stale resume.
- Manifest: clean-context reconstruction rejects wrong or incomplete chain,
  operation, address, role, code, ledger, supply, metadata, or policy evidence.
- Interop: every accepted row has positive and lookalike/malicious/replay/
  partial-failure negative fixtures; drift disables mutation.
- Media/web: hostile corpus for active formats, polyglots, decompression bombs,
  redirects, spoofing, and malicious links.
- Admin: multisig ceremony and compromise, pause, recovery, migration, and
  shutdown tabletop.
- Release: full CI, exact release commit/deployment manifest, real Shadownet
  journey, monitoring/incident exercise, and physical wallet/mobile rehearsal.

## 5. Incident principles

Pause the narrowest mutation capability, preserve reads and safe recovery, state
what is known without claiming unaffected safety, retain reconciliation
evidence, publish privileged-action and policy diffs, and require explicit
go/no-go to resume. Mainnet readiness is never inferred from Shadownet success.

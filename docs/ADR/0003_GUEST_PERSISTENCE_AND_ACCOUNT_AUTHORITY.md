# ADR 0003: Guest Persistence and Account Authority

- Status: adopted in Phase 0 for Phase 1
- Date: 2026-07-31
- Decision: SS-D-011

## Context

Samurai Sushi begins without a wallet, must preserve every confirmed service
result, and later lets a player claim guest progress without duplication or
loss. Browser-only state cannot provide transactional claims, deletion,
cross-device recovery, or reliable concurrency. A wallet address is a public
credential, not a private player record or an acceptable implicit profile.

## Decision

PostgreSQL behind the Samurai web server is the sole durable authority for
guest sessions, services, progress, exports, account links, and future player
identities. Browser state is an untrusted display cache. Phase 1 does not accept
offline mutations: if the server cannot confirm a command, the counter enters a
clear disconnected/read-only state at the last acknowledged checkpoint. It may
retry the exact command by idempotency key after reconnect, but it never invents
success or merges an independent local history.

Every mutation includes a client-generated idempotency key, subject, expected
revision, content version, and canonical payload hash. Keys are unique within
`(subjectKind, subjectId, idempotencyKey)`. The server looks up that scope before
checking the current revision: an exact payload-hash retry returns the stored,
versioned response, while reuse with a different hash fails. A new command then
commits its result, revision, domain event, outbox row, and repeatable response
in one transaction. Ordinary command receipts remain repeatable for 30 days or
until subject deletion. Raw bearer secrets are deliberately excluded from
stored responses: after a committed claim whose `Set-Cookie` response is lost,
the revoked guest cannot read the claim receipt and receives `REAUTH_REQUIRED`.
A fresh wallet proof discovers the committed player through its wallet
credential, revokes every `pending-delivery` session from that claim, and issues
a new one. This bearer-issuance exception is narrower than the ordinary
repeatable-response contract. Clients reuse a key only to retry the identical
canonical command; every different logical command or payload gets a new key.

Command payloads use UTF-8 RFC 8785 JSON Canonicalization Scheme bytes and
SHA-256 in the domain `samurai-sushi:command:v1`; digests are compared in
constant time. The durable receipt stores the response schema version and
canonical response payload, not only its hash. The server, never a command
handler, derives `resultHash` from
`samurai-sushi:command-response:v1\n` followed by the canonical JSON of
`{schemaVersion,payload}`. Outbox delivery is at-least-once and consumers
deduplicate by event ID. Workers claim with an unpredictable token plus a
monotonic generation under `FOR UPDATE SKIP LOCKED`; an expired lease loses
authority at the exact PostgreSQL-clock boundary, retry uses bounded backoff,
and terminal attempts become dead letters.

Stage 1 outbox claims expose only the opaque event ID and lease fence, never a
domain-event payload or subject identity. Guest deletion cascades the durable
event and claim, so a leased worker can neither retrieve nor acknowledge it
after deletion. A later payload-bearing delivery protocol requires a separately
reviewed authorization-aware final-dispatch boundary and an explicit resolution
of the fetch/send privacy race; this persistence spine does not authorize one.

### Guest identity

The server issues a random 256-bit resume secret only in a host-only
`__Host-samurai_guest` cookie with `Secure`, `HttpOnly`, `SameSite=Lax`, and
`Path=/`; no `Domain` is allowed. Unsafe methods require exact configured
`Origin`, JSON content type, and `X-Samurai-Request: 1`; CORS does not admit
credentialed foreign origins. Persistence-enabled local development uses
loopback HTTPS rather than weakening production cookie attributes.

The database stores `HMAC-SHA-256(digestKey[keyVersion], secret)` plus the key
version and a domain-separated SHA-256 identity of the exact private key bytes
for each current or predecessor digest and compares digests in constant time.
Key rings defensively own their key bytes and expose immutable epoch metadata:
activation, retirement, verification horizon, and compromise. Startup attests
both version and key identity, and requires every verification horizon to cover
the maximum live database dependency, including expired-session cleanup delay
and guest-deletion tombstones. Compromise rejects capability use immediately;
retention may still transform an expired subject into a tombstone using the
active tombstone writer so privacy cleanup cannot deadlock.

Cookie-secret rotation accepts the single predecessor digest for at most 60
seconds for in-flight requests. While that row is live, predecessor requests
authenticate without recursive rotation, current automatic rotation is
deferred, and explicit rotation returns a stable retry-at-grace-boundary error.
At equality the predecessor is expired and may be replaced. Command admission
requires rotation before receipt access when PostgreSQL time is at or beyond
`rotate_after`, or when a current digest uses a verification-only key;
predecessor requests inside grace remain admissible. Every committed or exact
replayed command updates `last_seen_at` under the session lock.

Digest-key rotation is separate: a retired key remains verification-only through
the session, cleanup, and tombstone horizons. Emergency compromise revokes every
session under that key and requires fresh guest recovery or wallet proof; it
never extends verification. Guest
sessions have a 30-day idle and absolute maximum and rotate at least every seven
active days, on recovery/export-import, or on a security event. Raw cookie
headers and secrets are redacted before application,
proxy, trace, error-report, or analytics logging. Guest play remains
browser-bound: there is no fingerprint, email requirement, analytics identity,
public profile, or wallet prompt before the first settled service.

Session, receipt, predecessor-grace, tombstone, lease, and cleanup boundaries
use the authoritative PostgreSQL clock. Process clocks never decide whether a
credential, response, tombstone, or worker claim remains valid. A transaction
samples that clock again after acquiring its session, idempotency, or lease
locks, and a command samples it again after its handler before any durable
write. Thus lock waits and slow decisions cannot cross an expiry, compromise,
rotation, or receipt boundary using stale authority time.

The sole persistence bootstrap first runs the production bundled migration and
exact live-catalog attestation and verifies the active tombstone writer. That
establishes retention-only readiness. It then inventories every key version
referenced by a live resume digest or tombstone. Session, command, and outbox
serving remain fail-closed if a version, key identity, lifecycle state, or
required horizon is unavailable, while retention remains able to delete or age
out affected rows after an emergency-compromise or key-loss restart. Serving
readiness may recover only after cleanup and a fresh successful inventory.

Guest deletion creates a tombstone for every stored resume digest. Before issue,
resume, command, or recovery acceptance, the server derives candidate resume
digests across every unexpired resume verification key, then derives deletion
tombstones across every unexpired tombstone verification key. Any exact live
match rejects the capability. Issue and deletion acquire the same sorted,
digest-derived advisory replay fences before changing a credential or its
tombstone, so a forced repeated secret cannot pass a precheck and resurrect
after concurrent deletion. Tombstones are live only while `expires_at` is
strictly greater than PostgreSQL time; equality is expired. Unauthenticated
commands are iteratively bounded by depth, node count, string size, and total
canonical bytes before recursive parsing or validation.

Unclaimed guests expire after 30 days of inactivity; a retention job must run
the same deletion matrix within 24 hours. Explicit guest deletion
immediately invalidates resume, export, import, and claim capability and removes
active guest/session, service, progress, command receipt, event/outbox,
export/import, merge, and analytics-join records. Encrypted operational backups
must age out within 30 days and must never restore deleted records as active. A
non-reversible replay tombstone may exist only for that window and contains no
subject identifier or payload that can restore the deleted identity.

### Export and recovery

Before wallet link, the close ledger offers an explicit portable encrypted save
export. The server keeps a private, subject-owned `SaveExportRecord` and
produces a distinct canonical envelope containing no raw guest/player ID: only
an export ID, subject revision, unlinkable claim commitment, content refs/hashes,
a maximum 29-day expiry, and integrity tag. The browser encrypts it with a user
passphrase using a versioned WebCrypto AEAD/KDF suite; the passphrase never
reaches the server or telemetry.

Import decrypts locally and submits the canonical envelope to the server. One
transaction validates integrity, schema/content compatibility, expiry,
deletion/claim state, idempotency, and server revision. It may create or resume
a guest, but never link a wallet, overwrite newer progress, or authorize an
onchain receipt. The implementation must publish exact crypto parameters,
upgrade behavior, and lost-passphrase copy before export is enabled.

Stage 2 narrows version 1 to same-subject resume only: an import resumes the
original active, unclaimed authoritative guest and never creates a parallel
guest or accepts browser checkpoint state. The locked server revision must
equal the exported revision. A newer server revision makes the file stale; a
lower server revision is an authority rollback and fails closed. Successful
import consumes the selected export, revokes sibling exports and every prior
guest credential without predecessor grace, and writes non-reversible
export/import replay tombstones. Import, guest deletion, and the later claim
transaction use the same guest-first lock order so exactly one can commit.

The persistence implementation resolves an export only far enough to discover
its private owner, then locks the guest parent before any export, import
receipt, progress, credential, or tombstone row. It resamples PostgreSQL time
after every potentially blocking parent, advisory, export, or idempotency lock.
Expiry equality is expired. Import accepts no current resume secret and no
browser checkpoint bytes: the authenticated envelope is the recovery
capability for the original still-active guest. Export creation does require a
live guest credential, and every content pack, reference, and payload hash in
the server MAC is derived from server-owned progress and content authority.
Caller-provided content assertions are never signed.

The server integrity tag is HMAC-SHA-256 over the exact UTF-8 bytes
`samurai-sushi:portable-save-integrity:v1\n` followed by canonical JSON of
`portableSaveClaims(envelope)`. That claims object excludes only
`integrity.tag`. Integrity keys use the separate `portable-integrity` purpose;
their identity is SHA-256 over the existing key-identity domain, the exact
bytes `portable-integrity\n`, and the private key bytes. Verification selects
the exact version-and-identity pair and compares decoded 32-byte tags in
constant time. Activation is inclusive; compromise, retirement for writing,
and `verifyUntil` are exclusive boundaries. Portable-integrity inventory and
serving readiness are recovery-local: a missing or compromised recovery key
fails portable export/import closed without blocking ordinary guest issue,
resume, or commands. Retention and deletion remain available so affected
private records can be removed.

Serving checks are selected-key scoped. A compromised verification-only key
rejects only envelopes and receipts bound to that exact version-and-identity
pair; it does not prevent a still-authenticated guest from exporting a
replacement under a healthy active key or prevent unrelated healthy-key
imports. A bounded retention operation locates missing, identity-mismatched,
compromised, or verification-expired private references without locking them,
then locks the guest parent first, refreshes PostgreSQL time, re-locks and
rechecks the child, deletes it, and writes the corresponding replay tombstone.
Integrity-key destruction remains forbidden until its last private export or
receipt reference is gone.

Each export receives a fresh random 256-bit unlinkable commitment. The private
record stores only its domain-separated hash and enforces uniqueness. It never
reuses a guest ID, session digest, stable claim commitment, or deterministic
subject HMAC. The envelope therefore contains no raw subject identifier, but
identical revisions or content hashes can still correlate files and must not
be described as whole-file anonymity.

Import idempotency stores a canonical non-secret request hash and the currently
issued credential digest, never a raw bearer secret. The first successful
import generates a fresh random resume secret. An exact retry before the
original envelope expiry revokes and tombstones the possibly undelivered
credential, generates a fresh random replacement, and updates the bounded
receipt in the same guest-first transaction. Changed input fails. At or after
the original envelope expiry even an exact retry is rejected; the additional
one-day receipt and replay-tombstone lifetime is rejection evidence only, not
an extension of capability authority. Concurrent exact retries serialize and
leave exactly one durable current credential.

The version 1 browser file is canonical JSON with the exact outer fields
`{format,formatVersion,suite,salt,nonce,ciphertext}`. Its fixed suite is
`PBKDF2-SHA256-A256GCM-v1`: PBKDF2-HMAC-SHA-256 with 600,000 iterations and a
fresh 16-byte salt derives a non-extractable 256-bit AES-GCM key; encryption
uses a fresh 12-byte nonce and a 128-bit tag. The canonical header is AEAD
additional authenticated data. The writer accepts no caller-selected crypto
parameters. The file is capped at 360 KiB, decrypted canonical envelope bytes
at 256 KiB, and passphrases at 256 UTF-8 bytes. Creation requires at least 12
Unicode scalars and 16 UTF-8 bytes. Passphrases are encoded exactly as entered:
no trimming, case folding, or Unicode normalization. Unknown fields, nonfatal
UTF-8, noncanonical JSON, padded or non-round-tripping base64url, unknown
suites, and out-of-bound values fail before the KDF where possible.

Wrong passphrase, AEAD failure, and encrypted payload tamper share the local
copy: “Couldn’t unlock this save. The passphrase or file may be incorrect.”
Creation states: “This passphrase encrypts your save. Samurai Sushi cannot
recover or reset it. Store it in your password manager. If you lose it, create
a new export from the original device before this save expires.” The
passphrase, plaintext envelope, ciphertext, capability IDs, commitments, and
integrity tags are excluded from telemetry and logs.

The integrity key version and identity are MAC-bound in the envelope.
Retirement stops new exports while verification-only keys continue accepting
pre-retirement envelopes through their recorded `verifyUntil` horizon;
compromise immediately revokes every unimported envelope under that key with a
clear re-export path. Export/import replay tombstones live for at least the
maximum 29-day export validity plus one day of clock skew. Claim challenges
expire in five minutes, so no challenge or idempotency horizon may exceed its
relevant tombstone.

### Player identity and guest claim

`Player.id` is an opaque server identity. A wallet link is a unique credential
keyed by full network and account identity, not the player primary key. Multiple
wallets may link to one player only through an explicit account flow; one wallet
cannot identify multiple players. Existing players are never auto-merged.

Wallet proof creates or rotates a `PlayerSession` whose independent random
256-bit secret uses a `__Host-samurai_player` cookie and the same host-only,
digest-key, origin, comparison, redaction, expiry, and rotation rules as the
guest session. Ordinary gameplay authenticates with that server session, not a
repeated wallet signature. Sessions are individually revocable. A second device
requires a new wallet proof and creates a separately revocable session; logout
revokes only the selected session unless the player chooses all devices. Player
sessions have a seven-day idle and 30-day absolute maximum and rotate after
claim, credential/recovery changes, seven active days, or a security event.

`ClaimGuestProgress` requires the resume secret and a fresh, five-minute,
single-use canonical signed challenge. First construct
`ClaimIntent {claimId,guestClaimCommitment,targetPlayerId?,createPlayer,
guestRevision,playerRevision?,idempotencyKey,contentVersion,
cosmeticSelections}`. `claimId` is a client-generated 128-bit value unique to
that claim and session issuance. The claim
commitment is a server-issued random 256-bit value stored on the guest, not its
ID; `cosmeticSelections` is a canonical map of selection IDs to option IDs. Its
`claimIntentHash` is SHA-256 over the UTF-8 bytes
`samurai-sushi:claim-intent:v1\n` followed by its RFC 8785 canonical JSON. The
signed challenge is
`{domain:"samurai-sushi:guest-claim:v1",schemaVersion,origin,chainId,account,
claimIntentHash,nonce,issuedAt,expiresAt}`. No hash includes itself.
Account parsing preserves the protocol-canonical Tezos address rather than
case-normalizing display text; signature verification selects the permitted
scheme from the decoded account/public-key form and verifies the exact canonical
bytes. The stored challenge hash is consumed inside the claim transaction.
Let `challengeBytes` be the UTF-8 RFC 8785 canonical JSON bytes of that exact
signed challenge. The database lookup value is
`SHA-256("samurai-sushi:claim-challenge-hash:v1\n" + challengeBytes)` and the
wallet signs `challengeBytes`; the golden fixture pins both.

The transaction locks subject rows in stable `(subjectKind, subjectId)` order,
then progress and owned rows, preventing conflicting lock order. It locks
guest/player revisions and all owned rows in one transaction; merges service
and unlock IDs as idempotent sets;
requires explicit selection for conflicting single-choice cosmetics; writes
one `ProgressMerge`; rewrites every private guest-owned row; and tombstones the
guest claim path. Immutable origin provenance uses a salted, unlinkable
commitment, after which the salt is destroyed. The durable merge record stores
that commitment rather than the raw guest ID. The same transaction creates the
new player session and immediately tombstones the guest path. No raw player
secret is stored for replay. A lost response therefore requires the explicit
fresh-wallet-proof recovery above; no post-claim request depends on the guest
secret.

Claim-issued sessions store `issuanceKind=claim` and `issuanceId=claimId`, with
a unique `(playerId, issuanceKind, issuanceId)` constraint. Fresh wallet proof
binds `recoverClaimId` in its signed payload, locks that exact session key, and
revokes only the matching pending-delivery session. Concurrent claims or devices
with different issuance IDs cannot revoke one another.

A second wallet, stale revision, replayed challenge, changed idempotency
payload, deleted/expired guest, or injected failure at any rewrite boundary
leaves both subjects and all ownership unchanged.

### Privacy and deletion

Gameplay analytics never include a wallet address. Any analytics join is
separately consented and cannot restore a deleted identity. Player deletion
immediately revokes player sessions and wallet credentials and removes active
service, progress, command receipt, event/outbox, export/import, merge, and
analytics-join records. Backups and a non-reversible replay tombstone must age
out within 30 days.

Optional public-chain receipts are irreversible and remain opaque. The delete
flow must disclose that boundary. No guest ID, orders, score, dialogue,
accessibility settings, analytics ID, IP history, or wallet-to-guest link is
published.

The deletion transaction and retention jobs follow this matrix:

| Store | Delete/anonymize rule | Maximum residual retention |
| --- | --- | --- |
| guest/player sessions and wallet credentials | hard delete or revoke, then delete | immediate active DB |
| progress, services, orders, preparations | hard delete | immediate active DB |
| command receipts and canonical response payloads | hard delete | immediate active DB |
| domain events, outbox, and dead letters | hard delete subject rows and payloads | immediate active DB |
| claim challenges | hard delete payload | immediate on deletion; otherwise five minutes |
| save exports, imports, and integrity records | hard delete payloads; retain only export-ID replay tombstone | 30 days |
| progress merges and origin commitments | hard delete | immediate active DB |
| analytics join | hard delete | immediate active DB |
| application/proxy/security logs | redact at ingestion; retain only non-identifying category/request ID | 30 days |
| encrypted backups | exclude from active restore and age out | 30 days, deployment gate |
| optional public receipt | cannot delete; contains no private service ID | chain lifetime |

The 30-day backup limit is an adopted operational requirement, not verified
deployment evidence until backup configuration and a restore drill prove it.

Replay tombstones use
`HMAC-SHA-256(tombstoneKey[keyVersion],
"samurai-sushi:deletion-tombstone:v1\n" + kind + ":" + replayKey)` over a
high-entropy export, import, claim, or idempotency replay key and store the
separate key version. Keys remain verification-only until all of their
tombstones expire, then are destroyed. Planned rotation writes new tombstones
with the active key; compromise fails closed for the affected import/claim
horizon. Expiry cleanup removes the tombstone and any expired private rows in
the same scheduled job.

## Staged implementation boundary

Only the first stage is required before Phase 1 service-state code merges:

1. **Persistence spine:** guest sessions, guest progress/checkpoint revision,
   command receipts with stored repeatable response, domain events/outbox/dead
   letters, deletion/replay tombstones, guest issue/resume/rotate/delete
   repositories, and one transactional CAS/idempotency executor. Add pure domain
   contracts for command envelopes, revision conflicts, and disconnected state.
2. **Portable recovery:** encrypted export/import only after the canonical
   envelope, WebCrypto profile, integrity-key lifecycle, expiry, and replay
   horizon above are implemented and reviewed.
3. **Account claim:** player sessions, wallet credentials, canonical challenge,
   and atomic guest claim only after stages 1–2. Wallet SDKs, endpoints, and UI
   remain out until those persistence primitives pass independent review.

## Acceptance and threat tests

- Rebuild a disposable real PostgreSQL database from empty; repeat migration is
  clean and required foreign-key, uniqueness, check, and revision constraints
  are exercised. An already-created namespace is not an empty install: first
  bootstrap accepts only a missing namespace, while later startup requires the
  exact ordered ledger and a matching live-catalog attestation.
- Valid resume works; wrong, expired, and deleted secrets fail. Raw secrets are
  absent from stored rows and log-shaped repository output.
- Exact idempotent retry returns the same result; changed payload and stale
  revision reject without mutation.
- Concurrent claim tests cover a second wallet, expired/deleted guest, stale
  guest/player revisions, replayed challenge, failure at every ownership
  rewrite boundary, repeated merge, import-before-merge, and changed payload.
  Exactly one claimant may commit.
- Challenge tests cover wrong guest/target player, create-player drift,
  wrong origin/chain/account, changed cosmetic selection/payload/content,
  expiration, replay, account parsing, signature scheme, and concurrent lock
  ordering.
- Golden fixtures pin the exact ClaimIntent canonical bytes, intent hash,
  challenge bytes, and accepted/rejected signature cases.
- Export tests cover tamper, wrong passphrase, incompatible schema/content,
  duplicate import, newer server revision, deletion, and lost-passphrase copy.
- Disconnection tests prove the UI cannot advance beyond the last acknowledged
  checkpoint and exact retry does not duplicate a step or service result.
- Claim tests prove the guest secret stops authorizing requests while the new
  player session authorizes the committed player revision. Reload, logout,
  credential revocation, stolen/stale session, concurrent cookie rotation, and
  second-device behavior follow the session rules above.
- Lost-response tests inject failure after claim commit and before response
  headers, prove the guest credential is invalid, retry returns
  `REAUTH_REQUIRED` without reading the receipt, and fresh wallet proof
  discovers the committed player and revokes the undelivered session before
  issuing a usable replacement. Two simultaneous pending claims prove recovery
  revokes only the signed `recoverClaimId` target.
- Deletion tests prove sessions, credentials, services, progress, command
  receipts, event/outbox rows, exports/imports, merges, analytics joins, and
  claim capability are gone; tombstones contain no reversible subject/payload.
  Backup-aging and public-receipt disclosures are operational/UI policy gates.
- Cookie tests cover the exact host-only attributes, unsafe-method Origin/header
  policy, wrong origin, stale/concurrent cookies, digest-key rotation,
  constant-time comparison boundary, reverse-proxy/application redaction, and
  loopback HTTPS behavior.
- Rotation tests distinguish predecessor cookie-secret grace from the 30-day
  HMAC verification-key horizon, including inactive sessions, overlapping dual
  rotation, and emergency mass reauthentication.
- Export boundaries cover import after claim/deletion and exact expiry/tombstone
  edges; compromised integrity keys reject affected unimported envelopes.
- Expiry tests run the full deletion matrix within 24 hours and verify the
  domain-separated tombstone digest, key version, rotation, destruction, and
  horizon boundary without retaining a reversible subject or payload.

## Consequences and exclusions

This decision authorizes the persistence/domain implementation boundary. It
does not authorize wallet UI, receipt contracts, analytics collection, public
deployment, offline mutation/synchronization, automatic player-to-player
merges, or wiring the current one-order shell to unfinished persistence.
LocalStorage and IndexedDB are not gameplay authorities. Redis and multi-device
live synchronization require measured need and a separate decision.

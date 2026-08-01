# Technical Specification

## 1. Proposed architecture

Working assumption: TypeScript/pnpm workspace. The server/Postgres authority
model is proposed, not adopted, until the Phase 0 persistence/account ADR
resolves offline play, privacy, deletion, and guest-to-wallet migration.

```text
apps/
  web/                 Next.js player UI and BFF
  chain-worker/        confirmation, ingestion, reorg, reconciliation
packages/
  domain/              pure commands, events, state machines, invariants
  content/             versioned ingredients, recipes, guests, services
  contracts/           generated types, policy and deployment manifests
  tezos/               Beacon/Taquito and RPC/indexer adapters
  persistence/         Postgres schema, migrations, repositories
  ui/                  accessible pixel primitives
contracts/
  assets/              optional FA2 ownership
  receipt/             service keepsake contract
  kitchen/             post-MVP versioned atomic crafting
  interoperability/    post-MVP exact-identity registry/adapters
  tests/               SmartPy scenarios and fixtures
```

The proposed MVP uses one web deployable, one async chain worker when the
receipt path ships, and Postgres. Phase 1 MAY use device-local durable prototype
state if the ADR defines export, recovery, and migration; no implementation may
silently close the authority decision. Add Redis only after measured need.

## 2. Proposed authority boundary

- Game server after ADR adoption: sessions, orders, timing, feedback, tutorial, progress,
  cosmetics, and content flags.
- Tezos: only deliberately transferable ownership and confirmed service
  receipts.
- Browser: never custody authority. Its durable gameplay role is decided by the
  Phase 0 ADR; local storage is not assumed disposable until then.
- Worker: RPC finality, indexed ingestion, reorg handling, canonical projection,
  stale-intent expiry, and reconciliation.
- Indexer: availability projection, never authorization.

Every mutation carries a stable intent/idempotency ID through API, wallet,
operation, event, projection, and receipt.

## 3. Canonical entities

```text
AssetRef { chainId, contractAddress, tokenId, standard, decimals, metadataDigest }
AcceptedAssetRef { semanticAssetKey, assetRef, policyVersion, enabled }
GuestSession { id, resumeSecretHash, state, createdAt, lastSeenAt, expiresAt, consentVersion }
Player { id, linkedWallets, tutorialState, createdAt }
PlayerProgress { subjectType, subjectId, revision, contentVersion, services, mastery, cosmetics }
ProgressMerge { idempotencyKey, guestId, playerId, guestRevision, playerRevision, resultDigest }
ServiceSession { id, playerId, contentVersion, state, openedAt, closedAt }
OrderTicket { id, sessionId, recipeId, modifiers, deadline, state }
Preparation { orderId, requiredSteps, completedSteps, mistakes, state }
RecipeVersion { id, version, stations, inputs, output, disposition, policyHash }
CraftIntent { id, account, chainId, recipeVersion, quantity, expectedDeltas, expiry }
ChainOperation { intentId, chainId, hash, source, status, confirmations, error }
InventoryProjection { account, assetRef, rawBalance, level, observedAt }
ReceiptDeploymentManifest { chain, operation, address, roles, issuerKey, code, schema, emptyState, receiptPolicy }
AssetDeploymentManifest { chain, operation, addresses, roles, code, ledger, supply, metadata, economicPolicy }
ReceiptPayload { domain, schemaVersion, chainId, account, destination, entrypoint, mutezAmount, serviceCommitment, contentVersion, nonce, expiry, manifestHash }
ReceiptPermit { payload, payloadHash, issuerKeyId, issuerPolicyVersion, issuerSignature }
ServiceReceipt { chainId, contract, owner, serviceCommitment, contentVersion, nonce, payloadHash, operationHash, state }
```

APIs and storage use decimal strings; chain boundaries use raw integer strings.
Token amounts never use JavaScript `number`.

### Guest identity and merge

The working implementation assumption issues a 256-bit opaque resume secret in
a Secure, HttpOnly, SameSite cookie and stores only its hash. Guest play is
device/browser-bound; no fingerprinting. Clearing site data loses the resume
secret, so the close ledger offers an encrypted save export until account link
is implemented. Inactive unclaimed guest records expire after 30 days; players
may delete immediately. Any longer retention requires explicit consent.

`ClaimGuestProgress` validates the guest resume secret and a fresh wallet-signed
challenge, locks guest and player revisions, and merges in one database
transaction. Service IDs and unlock events are idempotent sets. Conflicting
single-choice cosmetics require explicit player selection. Success writes a
`ProgressMerge`, tombstones the guest claim path, and is replay-safe. A guest
already claimed by another wallet, stale revision, reused challenge, duplicate
idempotency key with different payload, or partial write fails without mutation.
Wallet linking never automatically merges two existing player identities.

## 4. Service commands

- `StartService`: create one open service from `IDLE`.
- `AcceptOrder`: validate offered, unexpired, unlocked, capacity available.
- `PerformStep`: accept only the next required step; duplicate step is
  idempotent.
- `PlateOrder`: validate preparation and order identity.
- `ServeOrder`: serve only a plated, unexpired order and emit non-transferable
  progression.
- `CloseService`: produce a durable ledger and restoration choice.
- `AbandonService`: close outstanding orders without chain mutation.

## 5. Wallet/receipt commands

- `LinkWallet`: validate account, network, challenge scope, and privacy policy.
- `PrepareReceipt`: create an expiring exact payload; changes no chain state.
- `SubmitReceipt`: revalidate wallet runtime generation, session revision,
  source account, chain ID, permission scope, destination, entrypoint, attached
  mutez amount, canonical payload bytes, manifest hash, intent ID, and expiry at
  final dispatch with no intervening await.
- `ObserveOperation`: idempotently map RPC/indexer evidence to explicit states.
- `ConfirmReceiptProjection`: after the manifest-configured confirmation
  threshold; marks the normal projection recorded but not final.
- `FinalizeReceiptProjection`: only after the manifest-configured
  finality/cemented-block policy; marks the projection terminally finalized.

Transaction and attempt transitions, confirmation/finality policy, replacement,
drop, and reorg compensation are normative in `DOMAIN_SPEC.md`.

### Canonical receipt

The MVP representation is a non-transferable contract ledger record, not FA2.
The game issuer signs a one-time `ReceiptPermit` after a `SETTLED` service; the
player submits it from the bound wallet.

The canonical `ReceiptPayload` fields are `domain =
SAMURAI_SUSHI_RECEIPT_V1`, schema version, chain ID, wallet account, destination
contract, entrypoint, attached mutez amount (zero), opaque service commitment,
content version, one-time nonce, permit expiry, and deployment manifest hash.
`payloadBytes = Michelson PACK(ReceiptPayload)` and
`payloadHash = BLAKE2b-256(payloadBytes)`. The issuer signature covers
`payloadHash`; TypeScript and SmartPy golden fixtures MUST produce identical
packed bytes and hash. The contract reconstructs the typed payload from call
parameters, re-packs it, compares the hash, and verifies the signature.
The commitment is a hash of the private service record plus a server nonce; raw
guest ID, orders, scores, dialogue, and behavior remain offchain. Optional public
summary content requires separate opt-in and availability disclosure; a hash is
not an availability promise.

The contract verifies an active manifest-pinned issuer key/policy, sender/account
binding, expiry, destination, entrypoint, zero mutez, manifest hash, and
uniqueness of
`(owner, serviceCommitment)` and nonce;
then stores the minimal record and emits `service_receipt(owner,
service_commitment, content_version, nonce, payload_hash)`. Issuer key rotation,
pause, and revocation are manifest-bound privileged actions. Permit lifetime is
at most 15 minutes. Routine rotation stops issuance from the old key but retains
verification for 15 minutes; emergency revocation invalidates outstanding old-
key permits immediately. Exactly-once means
one accepted record for the uniqueness key under duplicate wallet/API/indexer
events.

Negative contract/golden tests mutate each payload field, payload hash, issuer
key ID/policy, and signature independently and require signature/policy failure
with zero accepted record. The local `intentId` remains part of the final
dispatch tuple and durable correlation, but is not a public service identifier
or a signed receipt field.

## 6. Contract boundaries

### MVP receipt contract

- Accepts a content-addressed summary of a completed service.
- Binds account, unlinkable service commitment, nonce, content version, and
  manifest version.
- Enforces exactly-once issuance.
- Does not accept tez, sell items, expose a faucet, grant progression, or imply
  financial value.
- It is a non-transferable ledger record, not an FA2 token.

The receipt-specific deployment manifest contains chain ID, origination
operation, contract address, admin/issuer/pause roles, issuer verification key,
code hash, schema/entrypoints, initial empty receipt/nonce state, and receipt
policy hash. FA2 ledger/supply, token metadata, recipe, and kitchen policy fields
are not applicable. Future asset/kitchen contracts have separate typed manifests.

### Future assets/kitchen

Asset and kitchen concerns are split. Kitchen recipes are immutable/versioned,
bounded, atomic, and evented. Production artifacts MUST exclude rehearsal
faucets, public minting, marketplace, migration, and test-only randomness.

## 7. Environment contract

- Local: deterministic content, Postgres, mocked wallet/indexer, no public writes.
- Preview: ephemeral app/database and fixture-only chain adapter.
- Shadownet: real wallet/contracts, isolated manifest, test assets.
- Staging: production-shaped services against separately attested test deploy.
- Mainnet: explicit configuration only, immutable manifest, multisig roles, no
  test entrypoint/key in runtime.

Startup fails on missing/unknown environment, chain/address/hash mismatch, or
unverifiable readiness; it never silently falls back to mainnet.

## 8. Test strategy

- Domain unit/property tests for transitions, conservation, bounds, decimal
  scaling, idempotency, and replay.
- Content/schema tests for duplicate IDs, broken recipe graphs, missing review,
  and unreachable output.
- SmartPy tests for authorization, exactly-once receipt, failure atomicity,
  events, pause scope, manifest drift, and forbidden entrypoints.
- Golden cross-language tests for identical canonical policy hashes.
- Wallet race tests across every await and final dispatch.
- Adapter fixtures for pagination, malformed data, lag, outage, and reorg.
- Postgres integration for transactional intent, unique constraints, worker
  replay, and projection rebuild.
- Exact-manifest Shadownet E2E and separate production-shaped smoke.
- Browser/a11y tests at 320, 390, 768, 1024, and 1440 px.

Required CI: format, lint, typecheck, schema/content validation, unit/property/
integration tests, SmartPy compile/scenarios, artifact-size and forbidden-
entrypoint checks, policy/manifest verification, production/Shadownet builds,
Playwright/a11y, dependency/secret/license/static scans, and migration rebuild.

## 9. Observability and privacy

Logs include intent ID, environment, manifest version, typed state/failure, and
correlation IDs, but never private keys, seeds, signature payloads, or raw errors
that may contain secrets. Wallet addresses are pseudonymous identifiers and are
not joined to behavioral analytics unless necessary, disclosed, and retained
under an explicit policy.

Alert on privileged actions, manifest/registry drift, reconciliation mismatch,
stalled confirmations, repeated dispatch rejection, indexer/RPC divergence,
and duplicate-intent pressure.

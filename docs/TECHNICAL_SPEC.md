# Technical Specification

## 1. Architecture

Adopted application spine: TypeScript/pnpm workspace, Next.js web/BFF, and the
ADR 0003 PostgreSQL persistence authority. Browser state is an untrusted display
cache and Phase 1 accepts no offline mutation.

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

The MVP uses one web deployable, PostgreSQL, and one async chain worker when the
receipt path ships. On server loss, Phase 1 remains at the last acknowledged
checkpoint in an explicit disconnected/read-only state. Add Redis only after
measured need.

## 2. Authority boundary

- Game server/PostgreSQL: durable sessions, orders, timing, feedback, tutorial,
  progress, cosmetics, content flags, exports, and account links.
- Tezos: only deliberately transferable ownership and confirmed service
  receipts.
- Browser: never custody authority. LocalStorage and IndexedDB are not durable
  gameplay authorities; unconfirmed UI state cannot advance the service.
- Worker: RPC finality, indexed ingestion, reorg handling, canonical projection,
  stale-intent expiry, and reconciliation.
- Indexer: availability projection, never authorization.

Every mutation carries a stable intent/idempotency ID through API, wallet,
operation, event, projection, and receipt.

## 3. Canonical entities

```text
AssetRef { chainId, contractAddress, tokenId, standard, decimals, metadataDigest }
VersionedRef { id, version }
SpeciesDefinition { id, version, contentHash, reviewId, scientificName, localizedCommonNames, marketNames, group }
IngredientDefinition { id, version, contentHash, reviewId, kind, speciesRef?, productKind?, roles, names, glossary, baseContainsAllergens, baseMayContainAllergens, baseCrossContactTags, artKey }
CutStyle { id, version, contentHash, names, glossary, compatibleProductKinds, presentationClass, reviewId }
PreparedComponent { id, version, contentHash, ingredientRef, cutStyleRef?, treatment, rawNotice, containsAllergens, mayContainAllergens, crossContactTags, stationSteps, artKey, reviewId }
DishFamily { id, version, contentHash, reviewId, form, requiredRoles, allowedRoles, noriPlacement, namingRules, platingRules }
ComponentSlot { role, componentRef:VersionedRef, noriPlacement? }
DishDefinition { id, version, contentHash, reviewId, familyRef, names, glossary, componentSlots:[ComponentSlot], rawProfile, containsAllergens, mayContainAllergens, crossContactTags, dietaryTags, presentationRules, nonColorIdentity, artKey }
ComponentAmount { componentRef:VersionedRef, quantity, unit:portion, role }
RecipeVariant { id, version, contentHash, reviewId, baseRecipeRef, substitutions, resultingDishRef, reason, reviewIds, status }
SeasonWindow { startLocalDateInclusive, endLocalDateExclusive, availability }
SeasonalityRule { id, version, contentHash, reviewId, subjectRef:{kind,id,version}, regionId, ianaTimeZone, calendar, tzdbVersion, windows:[SeasonWindow], sourceRef, reviewedAt }
ProvenanceProfile { id, version, contentHash, semanticSubjectRef, claimType, claimValue, evidenceRef, validFrom?, validUntil?, reviewStatus }
AssetBinding { id, version, semanticSubjectRef, assetRef, use, policyVersion, manifestHash, reviewIds, enabled }
ArtAsset { key, digest, nonColorIdentity }
ContentPack { id, version, contentHash, reviewId, schemaVersion, speciesRefs, ingredientRefs, cutStyleRefs, componentRefs, familyRefs, dishRefs, recipeRefs, variantRefs, seasonalityRuleRefs, contentManifestHash, artAssetMapHash, archivePolicy, reviewerSignoffs }
ContentBundle { schemaVersion, pack, species, ingredients, cutStyles, components, families, dishes, recipes, variants, seasonalityRules, artAssets:[ArtAsset], reviewReferences }
GuestSession { id, claimCommitment, resumeSecretDigest, digestKeyVersion, previousSecretDigest?, previousDigestKeyVersion?, previousDigestExpiresAt?, state, revision, createdAt, lastSeenAt, expiresAt, consentVersion }
Player { id, tutorialState, revision, createdAt }
PlayerSession { id, playerId, issuanceKind:claim|wallet-proof, issuanceId, sessionSecretDigest, digestKeyVersion, previousSecretDigest?, previousDigestKeyVersion?, previousDigestExpiresAt?, state:pending-delivery|active|revoked, createdAt, lastSeenAt, expiresAt, revokedAt? }
WalletCredential { playerId, chainId, account, state, linkedAt }
SubjectRef = GuestSubject { guestSessionId } | PlayerSubject { playerId }
PlayerProgress { subjectType, subjectId, revision, contentVersion, services, mastery, cosmetics }
CommandReceipt { subject:SubjectRef, idempotencyKey, expectedRevision, contentVersion, payloadHash, responseSchemaVersion, responsePayload, resultHash, committedRevision }
DomainEvent { eventId, subject:SubjectRef, eventType, schemaVersion, payload, committedRevision, createdAt }
OutboxDelivery { eventId, destination, state, attempts, nextAttemptAt, deliveredAt? }
SaveExportRecord { exportId, subject:SubjectRef, subjectRevision, contentVersion, payloadHash, integrityKeyVersion, state, expiresAt }
PortableSaveEnvelope { exportId, subjectRevision, guestClaimCommitment, contentRefs, contentHashes, integrityKeyVersion, expiresAt, integrityTag }
ClaimChallenge { challengeHash, claimIntentHash, claimId, chainId, account, state, issuedAt, expiresAt, consumedAt? }
DeletionTombstone { kind, replayKeyDigest, tombstoneKeyVersion, expiresAt }
ProgressMerge { mergeId, claimId, idempotencyKey, guestOriginCommitment, playerId, guestRevision, playerRevision, payloadHash, resultDigest }
ServiceSession { id, subject:SubjectRef, originKind, originSubjectCommitment, contentVersion, state, openedAt, closedAt }
OrderTicket { id, sessionId, recipeRef, dishRef, modifiers, deadline, state }
Preparation { orderId, requiredSteps, completedSteps, mistakes, state }
RecipeVersion { id, version, contentHash, reviewId, dishRef, exactComponentAmounts:[ComponentAmount], stationSequence, deterministicResult:VersionedRef, unlockRule:available-at-start|first-service-settled, recovery:retry-with-corrective-cue|staff-meal|return-components, seasonalityRuleRefs, status }
CraftIntent { id, account, chainId, recipeVersion, quantity, expectedDeltas, expiry }
ReceiptIntent { id, subject:SubjectRef, account, serviceCommitment, payloadHash, manifestHash, state, expiresAt, createdAt }
OperationAttempt { id, intentId, chainId, hash, source, counter, state, replacesAttemptId, replacedByAttemptId, includedLevel, includedBlockHash, orphanedBlockHash, confirmations, submittedAt, includedAt, confirmedAt, finalizedAt, lastObservedAt, errorCode }
InventoryProjection { account, assetRef, rawBalance, level, observedAt }
IssuerKeyPolicy { keyId, policyVersion, publicKey, status, activatesAt, retiresAt, verifyUntil }
ReceiptDeploymentManifest { chain, operation, address, roles, issuerKeyRegistry, code, schema, emptyState, receiptPolicy }
AssetDeploymentManifest { chain, operation, addresses, roles, code, ledger, supply, metadata, economicPolicy }
ReceiptPayload { domain, schemaVersion, chainId, account, destination, entrypoint, mutezAmount, serviceCommitment, contentVersion, nonce, issuedAt, expiry, manifestHash, issuerKeyId, issuerPolicyVersion }
ReceiptPermit { payload, payloadHash, issuerSignature }
ServiceReceipt { chainId, contract, owner, serviceCommitment, contentVersion, nonce, payloadHash, operationHash, state }
```

APIs and storage use decimal strings; chain boundaries use raw integer strings.
Token amounts never use JavaScript `number`.

Published content rows are append-only and every transitive reference is a
`VersionedRef`. Editing a species, ingredient, cut, component, family, dish,
variant, seasonality rule, or recipe creates a new version and content hash.
Every field ending in `Ref`/`Refs` contains one or more `VersionedRef` values.
Art references resolve to immutable content digests included in the owning row
and content-pack hashes.
Historical orders pin recipe and dish refs; their recipe pins every component,
family, seasonality, allergen/raw profile, recovery result, and output needed to
replay the original meaning.

`AssetBinding` is the only authorization record connecting semantic content to
an onchain asset. Any read-optimized accepted-asset view is a non-authoritative
projection rebuilt from the manifest-verified binding registry; disagreement,
missing manifest evidence, or drift disables the operation.

Allergen derivation preserves three independent sets. Dish `contains` is the
union of component `contains`; `mayContain` is the union of component
`mayContain`; cross-contact is the union of component cross-contact tags. Rules
may conservatively add entries but never remove a contained allergen or
downgrade it to may-contain/cross-contact.

Season windows are ISO-8601 Gregorian local dates with half-open
`[startLocalDateInclusive, endLocalDateExclusive)` bounds. The service derives
and pins its local date at open using the rule's IANA zone and pinned tzdb
version. Only exact subject-version and region matches participate. No match is
valid `unspecified`; malformed/negative windows, unknown zone/calendar, or
overlapping matching windows with contradictory availability produce
`SEASONALITY_UNRESOLVED` and reject activation.

### Guest identity and merge

The adopted guest boundary issues distinct 256-bit opaque resume and claim
capabilities in `__Host-samurai-guest` and `__Host-samurai-guest-claim`
Secure, HttpOnly, SameSite=Strict, Path=/ cookies and stores only keyed digests. Guest play is
device/browser-bound; no fingerprinting. Clearing site data loses the resume
secret, so the close ledger offers the ADR 0003 encrypted save export until
account link. Inactive unclaimed guests expire after 30 days. Explicit deletion
removes active private data immediately; encrypted backups and a non-reversible
replay tombstone must age out within 30 days.

Each command carries an idempotency key, subject, expected revision, content
version, and canonical payload hash. PostgreSQL commits the result, revision,
event/outbox, and repeatable response atomically. Exact retry returns the prior
stored response after looking up `(subjectKind, subjectId, idempotencyKey)`
before revision CAS; changed payload or revision fails without mutation. Server
loss produces an explicit disconnected/read-only state at the last acknowledged
checkpoint. Stored response payloads never contain raw bearer secrets.

`ClaimGuestProgress` validates the guest resume secret and a fresh wallet-signed
challenge, locks guest and player revisions, and merges in one database
transaction. Service IDs and unlock events are idempotent sets. Conflicting
single-choice cosmetics require explicit player selection. Success writes a
`ProgressMerge`, creates a keyed-digest `PlayerSession`, tombstones the guest
claim path, and is replay-safe. The new random player-session secret is returned
only in the `__Host-samurai-player` Secure, HttpOnly, SameSite=Strict, Path=/ cookie; ordinary gameplay does not
require repeat wallet signatures. Claim-issued sessions begin
`pending-delivery`; only the dedicated exact player/claim/session/generation
acknowledgement request activates them. If
the claim response is lost, its retry receives `REAUTH_REQUIRED` without reading
the claim receipt; fresh wallet proof resolves the player through its wallet
credential, revokes the pending session, and issues a replacement. A guest
already claimed by another wallet, stale revision, reused challenge, duplicate
idempotency key with different payload, or partial write fails without mutation.
Wallet linking never automatically merges two existing player identities.
The account transport also provides one strict Origin-protected POST reset that
clears guest, guest-claim, and player cookies with the exact original `__Host-`
attributes. It reveals no credential validity and performs no persistence
mutation; it exists only to recover from browser-retained expired HttpOnly
cookies before beginning a fresh guest or wallet flow.

Every `ServiceSession` has exactly one `SubjectRef`: an unclaimed guest session
or a player. On a successful claim, the same transaction rewrites the guest's
service sessions and progress to the player subject while preserving immutable
origin provenance as `originKind = guest` plus a salted, unlinkable
`originSubjectCommitment`; it then destroys the commitment salt. No raw guest ID
is retained in public data or exposed as a reversible provenance link. Guest or
player deletion removes active sessions, wallet credentials, services,
progress, command receipts, event/outbox rows, exports/imports, merges, and
analytics joins; non-reversible tombstones and encrypted backups must age out
within 30 days. Guest expiry runs the same deletion matrix within 24 hours. Any
optional public receipt remains irreversible and opaque.

Persistence tests cover a claim attempted by a second wallet, an expired or
deleted guest, stale guest/player revisions, a partial subject rewrite, a
repeated merge, merge after save export, and replay with a changed payload. Each
failure leaves both subjects and all service ownership unchanged.

## 4. Service commands

The implemented Phase 1 boundary uses the existing guest/player progress,
command-receipt, domain-event, and outbox tables rather than creating a fourth
gameplay bearer or a parallel service history. `EveningServiceAuthority`
resolves one server-held guest or acknowledged active player credential, locks
the subject parent before subject-scoped idempotency and progress authority,
looks up exact replay before revision CAS, revalidates PostgreSQL time and key
authority after its final blocking lock, and commits checkpoint/event/outbox/
receipt atomically. Claim rewrites the same progress, receipts, events, and
outbox provenance to the player in the existing transaction; deletion removes
the same private rows.

The strict POST routes `/api/account/service` and
`/api/account/service/command` admit the normal guest+claim cookie pair or one
player cookie, reject guest/player mixtures before body work, and reject all
client-supplied subject, account, proof, chain, clock, randomness, and key
fields. Responses are no-store and contain only the canonical checkpoint,
pinned projection, disposition, and bounded non-secret result fields.

- `StartService`: create one open service from `IDLE`.
- `AcceptOrder`: validate offered, unexpired, unlocked, capacity available.
- `PerformStep`: accept only the next required step; duplicate step is
  idempotent.
- `PlateOrder`: validate preparation and order identity.
- `ServeOrder`: serve only a plated, unexpired order and emit non-transferable
  progression.
- `CloseService`: produce a durable ledger and restoration choice.
- `AbandonService`: close outstanding orders without chain mutation.

The current evidence boundary is pure/unit, migration/catalog attestation,
disposable PostgreSQL, and locally built production HTTP. Browser service UI,
animation/assets, wallet SDK/network calls, keepsake contracts, chain workers,
analytics, rate limiting, durable TLS/proxy deployment, and device/human
usability proof remain later gates.

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

`ReceiptIntent.id` is the durable local correlation key and parent of one or
more `OperationAttempt` rows. `(chainId, hash)` and `(intentId, id)` are unique.
A replacement creates a new attempt under the same intent and links both rows;
it never overwrites the prior hash or evidence. Inclusion and reorg processing
records canonical and orphaned block identities and timestamps. Exactly one
accepted canonical attempt may populate `ServiceReceipt.operationHash`; all
other attempts remain durable history. Re-inclusion updates the same attempt
idempotently rather than creating a new receipt or attempt.

### Canonical receipt

The MVP representation is a non-transferable contract ledger record, not FA2.
The game issuer signs a one-time `ReceiptPermit` after a `SETTLED` service; the
player submits it from the bound wallet.

The canonical `ReceiptPayload` fields are `domain =
SAMURAI_SUSHI_RECEIPT_V1`, schema version, chain ID, wallet account, destination
contract, entrypoint, attached mutez amount (zero), opaque service commitment,
content version, one-time nonce, issuance time, permit expiry, deployment
manifest hash, issuer key ID, and issuer policy version. Key selection and
rotation policy are therefore signed rather than supplied out of band.
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
uniqueness of `(owner, serviceCommitment)` and nonce; then stores the minimal
record and emits `service_receipt(owner, service_commitment, content_version,
nonce, payload_hash)`. Issuer key rotation, pause, and revocation are
manifest-bound privileged actions. The manifest carries a typed
`IssuerKeyPolicy` registry. The contract requires `issuedAt` to fall between the
key's activation and retirement, `expiry - issuedAt <= 15 minutes`, a
manifest-pinned `maxClockSkewSeconds = 30`, and verification before
`verifyUntil`. Time windows are half-open: `activatesAt <= issuedAt < retiresAt`,
`issuedAt <= now + maxClockSkewSeconds`, `issuedAt < expiry`, `now < expiry`, and
`now < verifyUntil`. A negative or zero permit duration is invalid. The issuer service
stops old-key issuance at retirement. During a routine overlap, the contract
cannot prove when an old-key signature was physically produced, so it accepts
any otherwise valid, pre-retirement-dated old-key permit until `verifyUntil`;
the 15-minute maximum lifetime bounds that exposure. Suspected compromise uses
emergency revocation, which invalidates outstanding old-key permits immediately.
Exactly-once means
one accepted record for the uniqueness key under duplicate wallet/API/indexer
events.

Negative contract/golden tests mutate each payload field, payload hash, issuer
key ID/policy, and signature independently and require signature/policy failure
with zero accepted record. The local `intentId` remains part of the final
dispatch tuple and durable correlation, but is not a public service identifier
or a signed receipt field.

Rotation tests cover immediately below, at, and above every activation,
retirement, expiry, verification-cutoff, maximum-lifetime, and clock-skew
boundary; negative and zero duration; new-key activation; a payload dated after
old-key retirement; emergency revocation of an outstanding permit;
cross-key/policy substitution; and manifest/key-registry drift. Every invalid
case records no receipt and emits no accepted result.

## 6. Contract boundaries

### MVP receipt contract

- Accepts an issuer-attested typed payload for a completed service.
- Binds account, unlinkable service commitment, nonce, content version, and
  manifest version.
- Enforces exactly-once issuance.
- Does not accept tez, sell items, expose a faucet, grant progression, or imply
  financial value.
- It is a non-transferable ledger record, not an FA2 token.

The receipt-specific deployment manifest contains chain ID, origination
operation, contract address, admin/issuer/pause roles, issuer key-policy
registry, code hash, schema/entrypoints, initial empty receipt/nonce state, and
receipt policy hash. The receipt policy pins the confirmation threshold, the
distinct finality/cemented-block policy identifier, maximum permit lifetime,
issuer key rotation/revocation policy, and `maxClockSkewSeconds = 30`. FA2
ledger/supply, token metadata, recipe, and kitchen policy fields are not
applicable. Future asset/kitchen contracts have separate typed manifests.

### Future assets/kitchen

Asset and kitchen concerns are split. Kitchen recipes are immutable/versioned,
bounded, atomic, and evented. Production artifacts MUST exclude rehearsal
faucets, public minting, marketplace, migration, and test-only randomness.

## 7. Environment contract

- Localnet: required default for ordinary development, contract iteration, and
  integration tests; shared loopback RPC, deterministic accounts, no public
  writes, and no indexer in the base runtime.
- Preview: ephemeral app/database and fixture-only chain adapter.
- Shadownet: explicit final rehearsal only; real wallet/contracts, isolated
  manifest, and test assets.
- Staging: production-shaped services against separately attested test deploy.
- Mainnet: unsupported by development commands. A future production decision
  requires a separate reviewed release path, immutable manifest, multisig
  roles, and no test entrypoint/key in runtime.

Startup fails on missing/unknown environment, chain/address/hash mismatch, or
unverifiable readiness; it never silently falls back to Shadownet or Mainnet.
Server and browser-visible network, RPC, chain ID, and indexer values must
match exactly. Localnet must use `127.0.0.1:8732`, chain
`NetXtJqPyJGB6Pc`, and no public indexer. Indexer-backed paths return a
controlled unavailable state until a separately validated local indexer exists.
The implementation command contract and lifecycle are normative in
`TEZOS_LOCALNET_LIFECYCLE.md`.

The first account HTTP integration is a Node-only composition and local
production-build proof, not a deployment claim. Wallet SDK/network calls,
browser claim UI, analytics, background workers, rate-limit infrastructure,
durable TLS/reverse-proxy deployment, and physical-device proof remain later
gates.

## 8. Test strategy

- Domain unit/property tests for transitions, conservation, bounds, decimal
  scaling, idempotency, and replay.
- Content/schema tests for duplicate IDs, broken recipe graphs, missing review,
  unreachable output, family-slot violations, wildcard/ambiguous variants,
  species/product/cut mismatch, raw-notice gaps, allergen derivation conflicts,
  seasonality boundaries, unsupported provenance, and semantic/asset lookalikes.
- Historical-content fixtures update each transitive entity and prove pinned
  orders retain byte-equivalent components, raw/allergen profile, recovery,
  output, art, and content hash.
- Allergen fixtures reject a `contains` → `mayContain` or cross-contact
  downgrade. Asset fixtures make binding/projection disagreement fail closed.
- Seasonality fixtures exercise immediately below/at/above every half-open
  boundary, negative and zero windows, leap dates, UTC-to-local conversion at
  DST transitions, region mismatch, contradictory overlap, unknown tzdb, and
  valid no-rule `unspecified` behavior.
- Golden content builds prove finite, acyclic, duplicate-free variant expansion
  and byte-identical content hashes across repeated builds.
- SmartPy tests for authorization, exactly-once receipt, failure atomicity,
  events, pause scope, manifest drift, and forbidden entrypoints.
- Golden cross-language tests for identical canonical policy hashes.
- Wallet race tests across every await and final dispatch.
- Adapter fixtures for pagination, malformed data, lag, outage, and reorg.
- Postgres integration for transactional intent, unique constraints, worker
  replay, and projection rebuild.
- Localnet contract/integration E2E, exact-manifest Shadownet E2E, and separate
  production-shaped smoke.
- Browser/a11y tests at 320, 390, 768, 1024, and 1440 px.

Required CI: format, lint, typecheck, schema/content validation, unit/property/
integration tests, SmartPy compile/scenarios, artifact-size and forbidden-
entrypoint checks, policy/manifest verification, Localnet/Shadownet builds,
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

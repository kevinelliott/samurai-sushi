# Technical Specification

## 1. Proposed architecture

Adopted Phase 0 application spine: TypeScript/pnpm workspace and Next.js web
shell. The server/Postgres authority model remains proposed, not adopted, until
the Phase 0 persistence/account ADR resolves offline play, privacy, deletion,
and guest-to-wallet migration.

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
VersionedRef { id, version }
SpeciesDefinition { id, version, contentHash, scientificName, localizedCommonNames, marketNames, group, culinaryReviewId }
IngredientDefinition { id, version, contentHash, kind, speciesRef?, productKind?, names, glossary, baseContainsAllergens, baseMayContainAllergens, baseCrossContactTags, artKey, reviewId }
CutStyle { id, version, contentHash, names, glossary, compatibleProductKinds, presentationClass, reviewId }
PreparedComponent { id, version, contentHash, ingredientRef, cutStyleRef?, treatment, rawNotice, containsAllergens, mayContainAllergens, crossContactTags, stationSteps, artKey, reviewId }
DishFamily { id, version, contentHash, structuralSlots, forbiddenSlots, namingRules, platingRules, reviewId }
DishDefinition { id, version, contentHash, familyRef, names, componentSlots, rawProfile, containsAllergens, mayContainAllergens, crossContactTags, dietaryTags, presentationRules, artKey, reviewId }
ComponentAmount { componentRef:VersionedRef, quantity, role }
RecipeVariant { id, version, contentHash, baseRecipeRef, substitutions, resultingDishRef, reviewIds, status }
SeasonWindow { startLocalDateInclusive, endLocalDateExclusive, availability }
SeasonalityRule { id, version, contentHash, subjectRef, regionId, ianaTimeZone, calendar, tzdbVersion, windows:[SeasonWindow], sourceRef, reviewedAt }
ProvenanceProfile { id, version, contentHash, semanticSubjectRef, claimType, claimValue, evidenceRef, validFrom?, validUntil?, reviewStatus }
AssetBinding { id, version, semanticSubjectRef, assetRef, use, policyVersion, manifestHash, reviewIds, enabled }
ContentPack { id, version, contentHash, speciesRefs, ingredientRefs, componentRefs, dishRefs, recipeRefs, seasonalityRuleRefs, archivePolicy, reviewSignoffs }
GuestSession { id, resumeSecretHash, state, createdAt, lastSeenAt, expiresAt, consentVersion }
Player { id, linkedWallets, tutorialState, createdAt }
SubjectRef = GuestSubject { guestSessionId } | PlayerSubject { playerId }
PlayerProgress { subjectType, subjectId, revision, contentVersion, services, mastery, cosmetics }
ProgressMerge { idempotencyKey, guestId, playerId, guestRevision, playerRevision, resultDigest }
ServiceSession { id, subject:SubjectRef, originKind, originSubjectCommitment, contentVersion, state, openedAt, closedAt }
OrderTicket { id, sessionId, recipeRef, dishRef, modifiers, deadline, state }
Preparation { orderId, requiredSteps, completedSteps, mistakes, state }
RecipeVersion { id, version, dishRef, exactComponentAmounts:[ComponentAmount], stationSequence, output, disposition, unlock, recovery, seasonalityRuleRefs, contentHash, policyHash, status }
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

Every `ServiceSession` has exactly one `SubjectRef`: an unclaimed guest session
or a player. On a successful claim, the same transaction rewrites the guest's
service sessions and progress to the player subject while preserving immutable
origin provenance as `originKind = guest` plus a salted, unlinkable
`originSubjectCommitment`; it then destroys the commitment salt. No raw guest ID
is retained in public data or exposed as a reversible provenance link. Deleting
an unclaimed guest deletes its private sessions and progress; after a claim,
player deletion follows the adopted retention policy while any optional public
receipt remains irreversible and opaque.

Persistence tests cover a claim attempted by a second wallet, an expired or
deleted guest, stale guest/player revisions, a partial subject rewrite, a
repeated merge, merge after save export, and replay with a changed payload. Each
failure leaves both subjects and all service ownership unchanged.

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

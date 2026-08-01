import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_BYTES = 32;
const DIGEST_BYTES = 32;
const KEY_IDENTITY_DOMAIN = "samurai-sushi:hmac-key-identity:v1\n";
const PORTABLE_SAVE_INTEGRITY_DOMAIN = "samurai-sushi:portable-save-integrity:v1\n";
const GUEST_CLAIM_CAPABILITY_DOMAIN = "samurai-sushi:guest-claim-capability:v1\n";
const PLAYER_SESSION_DOMAIN = "samurai-sushi:player-session:v1\n";
const KEY_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type HmacKeyPurpose =
  | "resume"
  | "tombstone"
  | "portable-integrity"
  | "guest-claim"
  | "player-session";
export type KeyIdentity = `sha256:${string}`;

export interface VersionedHmacKey {
  readonly version: number;
  readonly key: Uint8Array;
  readonly keyIdentity: KeyIdentity;
  readonly activatedAt: Date;
  readonly retiredAt: Date | null;
  readonly verifyUntil: Date | null;
  readonly compromisedAt: Date | null;
}

export interface HmacKeyMetadata {
  readonly version: number;
  readonly keyIdentity: KeyIdentity;
  readonly activatedAtMs: number;
  readonly retiredAtMs: number | null;
  readonly verifyUntilMs: number | null;
  readonly compromisedAtMs: number | null;
}

export interface VersionedDigest {
  readonly keyVersion: number;
  readonly keyIdentity: KeyIdentity;
  readonly digest: Uint8Array;
}

export type TombstoneKind =
  | "guest-session"
  | "command"
  | "save-export"
  | "save-import"
  | "guest-claim"
  | "claim-challenge"
  | "claim-id"
  | "claim-idempotency"
  | "player-session"
  | "wallet-credential";

interface PrivateKeyRecord {
  readonly metadata: HmacKeyMetadata;
  readonly bytes: Uint8Array;
}

function validDate(value: Date | null, name: string): void {
  if (value && !Number.isFinite(value.getTime())) throw new Error(`${name} must be a valid date or null.`);
}

export function hmacKeyIdentity(purpose: HmacKeyPurpose, key: Uint8Array): KeyIdentity {
  return `sha256:${createHash("sha256").update(KEY_IDENTITY_DOMAIN).update(`${purpose}\n`).update(key).digest("hex")}`;
}

function prepareKey(key: VersionedHmacKey, purpose: HmacKeyPurpose): PrivateKeyRecord {
  if (!Number.isSafeInteger(key.version) || key.version <= 0) throw new Error("HMAC key versions must be positive integers.");
  if (key.key.byteLength < SECRET_BYTES) throw new Error("HMAC keys must contain at least 256 bits.");
  if (!KEY_IDENTITY_PATTERN.test(key.keyIdentity)) throw new Error("HMAC key identities must use lowercase sha256:<hex> form.");
  const bytes = new Uint8Array(key.key);
  if (hmacKeyIdentity(purpose, bytes) !== key.keyIdentity) {
    throw new Error(`HMAC key version ${key.version} does not match its attested key identity.`);
  }
  validDate(key.activatedAt, "activatedAt");
  validDate(key.retiredAt, "retiredAt");
  validDate(key.verifyUntil, "verifyUntil");
  validDate(key.compromisedAt, "compromisedAt");
  if (key.retiredAt && key.retiredAt.getTime() <= key.activatedAt.getTime()) {
    throw new Error("HMAC retirement must be later than activation.");
  }
  if ((key.retiredAt === null) !== (key.verifyUntil === null)) {
    throw new Error("Retired HMAC keys require verifyUntil; active keys require both fields to be null.");
  }
  if (key.retiredAt && key.verifyUntil && key.verifyUntil.getTime() <= key.retiredAt.getTime()) {
    throw new Error("HMAC verifyUntil must be later than retirement.");
  }
  const metadata = Object.freeze({
    version: key.version,
    keyIdentity: key.keyIdentity,
    activatedAtMs: key.activatedAt.getTime(),
    retiredAtMs: key.retiredAt?.getTime() ?? null,
    verifyUntilMs: key.verifyUntil?.getTime() ?? null,
    compromisedAtMs: key.compromisedAt?.getTime() ?? null,
  });
  return { metadata, bytes };
}

function usable(record: PrivateKeyRecord, now: Date): boolean {
  const time = now.getTime();
  return record.metadata.activatedAtMs <= time
    && (record.metadata.verifyUntilMs === null || time < record.metadata.verifyUntilMs)
    && (record.metadata.compromisedAtMs === null || time < record.metadata.compromisedAtMs);
}

function withinVerificationHorizon(record: PrivateKeyRecord, now: Date): boolean {
  const time = now.getTime();
  return record.metadata.activatedAtMs <= time
    && (record.metadata.verifyUntilMs === null || time < record.metadata.verifyUntilMs);
}

function buildKeyMap(
  active: VersionedHmacKey,
  verificationOnly: VersionedHmacKey | readonly VersionedHmacKey[],
  purpose: HmacKeyPurpose,
): { readonly active: PrivateKeyRecord; readonly records: ReadonlyMap<number, PrivateKeyRecord> } {
  const preparedActive = prepareKey(active, purpose);
  if (preparedActive.metadata.retiredAtMs !== null) throw new Error("The active HMAC key must not be retired.");
  const prior = Array.isArray(verificationOnly) ? verificationOnly : [verificationOnly];
  const records = [preparedActive, ...prior.map((key) => prepareKey(key, purpose))];
  for (const record of records.slice(1)) {
    if (record.metadata.retiredAtMs === null) throw new Error("Verification-only HMAC keys must have a retirement horizon.");
    if (record.metadata.version === preparedActive.metadata.version) {
      throw new Error("Active and verification-only HMAC key versions must differ.");
    }
  }
  const map = new Map(records.map((record) => [record.metadata.version, record]));
  if (map.size !== records.length) throw new Error("HMAC key versions must be unique.");
  const identities = new Set(records.map((record) => record.metadata.keyIdentity));
  if (identities.size !== records.length) throw new Error("HMAC key identities must be unique within a purpose.");
  return { active: preparedActive, records: map };
}

export class HmacKeyring {
  readonly active: HmacKeyMetadata;
  readonly #activeRecord: PrivateKeyRecord;
  readonly #records: ReadonlyMap<number, PrivateKeyRecord>;

  constructor(active: VersionedHmacKey, verificationOnly: VersionedHmacKey | readonly VersionedHmacKey[] = []) {
    const prepared = buildKeyMap(active, verificationOnly, "resume");
    this.#activeRecord = prepared.active;
    this.#records = prepared.records;
    this.active = prepared.active.metadata;
  }

  digest(secret: string, now: Date, keyVersion = this.active.version): VersionedDigest {
    const record = this.#records.get(keyVersion);
    if (!record || !usable(record, now)) throw new KeyLifecycleError("KEY_VERSION_UNAVAILABLE", keyVersion);
    return {
      keyVersion,
      keyIdentity: record.metadata.keyIdentity,
      digest: createHmac("sha256", record.bytes).update(decodeResumeSecret(secret)).digest(),
    };
  }

  candidates(secret: string, now: Date): readonly VersionedDigest[] {
    decodeResumeSecret(secret);
    return [...this.#records.values()]
      .filter((record) => usable(record, now))
      .map((record) => this.digest(secret, now, record.metadata.version));
  }

  tombstoneCandidates(secret: string, now: Date): readonly VersionedDigest[] {
    decodeResumeSecret(secret);
    return [...this.#records.values()]
      .filter((record) => withinVerificationHorizon(record, now))
      .map((record) => ({
        keyVersion: record.metadata.version,
        keyIdentity: record.metadata.keyIdentity,
        digest: createHmac("sha256", record.bytes).update(decodeResumeSecret(secret)).digest(),
      }));
  }

  metadata(version: number): HmacKeyMetadata | undefined {
    return this.#records.get(version)?.metadata;
  }

  allMetadata(): readonly HmacKeyMetadata[] {
    return [...this.#records.values()].map((record) => record.metadata);
  }

  canVerify(version: number, now: Date): boolean {
    const record = this.#records.get(version);
    return Boolean(record && usable(record, now));
  }

  assertActive(now: Date): void {
    if (!usable(this.#activeRecord, now)) throw new KeyLifecycleError("ACTIVE_KEY_UNAVAILABLE", this.active.version);
  }
}

export class TombstoneKeyring {
  readonly active: HmacKeyMetadata;
  readonly #activeRecord: PrivateKeyRecord;
  readonly #records: ReadonlyMap<number, PrivateKeyRecord>;

  constructor(active: VersionedHmacKey, verificationOnly: readonly VersionedHmacKey[] = []) {
    const prepared = buildKeyMap(active, verificationOnly, "tombstone");
    this.#activeRecord = prepared.active;
    this.#records = prepared.records;
    this.active = prepared.active.metadata;
  }

  digest(kind: TombstoneKind, replayKey: string, now: Date, keyVersion = this.active.version): VersionedDigest {
    if (replayKey.length < 16) throw new Error("Replay keys must contain at least 16 characters of opaque material.");
    const record = this.#records.get(keyVersion);
    if (!record || !usable(record, now)) throw new KeyLifecycleError("KEY_VERSION_UNAVAILABLE", keyVersion);
    return {
      keyVersion,
      keyIdentity: record.metadata.keyIdentity,
      digest: createHmac("sha256", record.bytes)
        .update(`samurai-sushi:deletion-tombstone:v1\n${kind}:${replayKey}`, "utf8")
        .digest(),
    };
  }

  candidates(kind: TombstoneKind, replayKey: string, now: Date): readonly VersionedDigest[] {
    return [...this.#records.values()]
      .filter((record) => usable(record, now))
      .map((record) => this.digest(kind, replayKey, now, record.metadata.version));
  }

  replayCandidates(kind: TombstoneKind, replayKey: string, now: Date): readonly VersionedDigest[] {
    if (replayKey.length < 16) throw new Error("Replay keys must contain at least 16 characters of opaque material.");
    return [...this.#records.values()]
      .filter((record) => withinVerificationHorizon(record, now))
      .map((record) => ({
        keyVersion: record.metadata.version,
        keyIdentity: record.metadata.keyIdentity,
        digest: createHmac("sha256", record.bytes)
          .update(`samurai-sushi:deletion-tombstone:v1\n${kind}:${replayKey}`, "utf8")
          .digest(),
      }));
  }

  metadata(version: number): HmacKeyMetadata | undefined {
    return this.#records.get(version)?.metadata;
  }

  allMetadata(): readonly HmacKeyMetadata[] {
    return [...this.#records.values()].map((record) => record.metadata);
  }

  verificationMetadata(now: Date): readonly HmacKeyMetadata[] {
    return [...this.#records.values()].filter((record) => usable(record, now)).map((record) => record.metadata);
  }

  canVerify(version: number, now: Date): boolean {
    const record = this.#records.get(version);
    return Boolean(record && usable(record, now));
  }

  assertActive(now: Date): void {
    if (!usable(this.#activeRecord, now)) throw new KeyLifecycleError("ACTIVE_KEY_UNAVAILABLE", this.active.version);
  }
}

export class IntegrityKeyring {
  readonly active: HmacKeyMetadata;
  readonly #activeRecord: PrivateKeyRecord;
  readonly #records: ReadonlyMap<number, PrivateKeyRecord>;

  constructor(active: VersionedHmacKey, verificationOnly: readonly VersionedHmacKey[] = []) {
    const prepared = buildKeyMap(active, verificationOnly, "portable-integrity");
    this.#activeRecord = prepared.active;
    this.#records = prepared.records;
    this.active = prepared.active.metadata;
  }

  sign(canonicalClaims: Uint8Array, now: Date): VersionedDigest {
    if (!usable(this.#activeRecord, now)) throw new KeyLifecycleError("ACTIVE_KEY_UNAVAILABLE", this.active.version);
    return this.#tag(this.#activeRecord, canonicalClaims);
  }

  verify(
    canonicalClaims: Uint8Array,
    tag: Uint8Array,
    keyVersion: number,
    keyIdentity: KeyIdentity,
    now: Date,
  ): boolean {
    const record = this.#records.get(keyVersion);
    if (!record || !usable(record, now) || record.metadata.keyIdentity !== keyIdentity) {
      throw new KeyLifecycleError("KEY_VERSION_UNAVAILABLE", keyVersion);
    }
    return constantTimeDigestEqual(this.#tag(record, canonicalClaims).digest, tag);
  }

  metadata(version: number): HmacKeyMetadata | undefined {
    return this.#records.get(version)?.metadata;
  }

  allMetadata(): readonly HmacKeyMetadata[] {
    return [...this.#records.values()].map((record) => record.metadata);
  }

  canVerify(version: number, now: Date): boolean {
    const record = this.#records.get(version);
    return Boolean(record && usable(record, now));
  }

  assertActive(now: Date): void {
    if (!usable(this.#activeRecord, now)) throw new KeyLifecycleError("ACTIVE_KEY_UNAVAILABLE", this.active.version);
  }

  #tag(record: PrivateKeyRecord, canonicalClaims: Uint8Array): VersionedDigest {
    return {
      keyVersion: record.metadata.version,
      keyIdentity: record.metadata.keyIdentity,
      digest: createHmac("sha256", record.bytes)
        .update(PORTABLE_SAVE_INTEGRITY_DOMAIN, "utf8")
        .update(canonicalClaims)
        .digest(),
    };
  }
}

abstract class PurposeSeparatedCapabilityKeyring {
  readonly active: HmacKeyMetadata;
  readonly #activeRecord: PrivateKeyRecord;
  readonly #records: ReadonlyMap<number, PrivateKeyRecord>;

  protected constructor(
    active: VersionedHmacKey,
    verificationOnly: readonly VersionedHmacKey[],
    purpose: "guest-claim" | "player-session",
    private readonly digestDomain: string,
  ) {
    const prepared = buildKeyMap(active, verificationOnly, purpose);
    this.#activeRecord = prepared.active;
    this.#records = prepared.records;
    this.active = prepared.active.metadata;
  }

  digest(secret: string, now: Date, keyVersion = this.active.version): VersionedDigest {
    const bytes = decodeCapabilitySecret(secret);
    const record = this.#records.get(keyVersion);
    if (!record || !usable(record, now)) throw new KeyLifecycleError("KEY_VERSION_UNAVAILABLE", keyVersion);
    return this.#digest(record, bytes);
  }

  candidates(secret: string, now: Date): readonly VersionedDigest[] {
    const bytes = decodeCapabilitySecret(secret);
    return [...this.#records.values()]
      .filter((record) => usable(record, now))
      .map((record) => this.#digest(record, bytes));
  }

  tombstoneCandidates(secret: string, now: Date): readonly VersionedDigest[] {
    const bytes = decodeCapabilitySecret(secret);
    return [...this.#records.values()]
      .filter((record) => withinVerificationHorizon(record, now))
      .map((record) => this.#digest(record, bytes));
  }

  metadata(version: number): HmacKeyMetadata | undefined {
    return this.#records.get(version)?.metadata;
  }

  allMetadata(): readonly HmacKeyMetadata[] {
    return [...this.#records.values()].map((record) => record.metadata);
  }

  canVerify(version: number, now: Date): boolean {
    const record = this.#records.get(version);
    return Boolean(record && usable(record, now));
  }

  assertActive(now: Date): void {
    if (!usable(this.#activeRecord, now)) throw new KeyLifecycleError("ACTIVE_KEY_UNAVAILABLE", this.active.version);
  }

  #digest(record: PrivateKeyRecord, bytes: Uint8Array): VersionedDigest {
    return {
      keyVersion: record.metadata.version,
      keyIdentity: record.metadata.keyIdentity,
      digest: createHmac("sha256", record.bytes).update(this.digestDomain, "utf8").update(bytes).digest(),
    };
  }
}

export class GuestClaimKeyring extends PurposeSeparatedCapabilityKeyring {
  constructor(active: VersionedHmacKey, verificationOnly: readonly VersionedHmacKey[] = []) {
    super(active, verificationOnly, "guest-claim", GUEST_CLAIM_CAPABILITY_DOMAIN);
  }
}

export class PlayerSessionKeyring extends PurposeSeparatedCapabilityKeyring {
  constructor(active: VersionedHmacKey, verificationOnly: readonly VersionedHmacKey[] = []) {
    super(active, verificationOnly, "player-session", PLAYER_SESSION_DOMAIN);
  }
}

export function keyIdentityBytes(identity: KeyIdentity): Uint8Array {
  if (!KEY_IDENTITY_PATTERN.test(identity)) throw new Error("Invalid key identity.");
  return Buffer.from(identity.slice("sha256:".length), "hex");
}

export function keyIdentityFromBytes(value: Uint8Array): KeyIdentity {
  if (value.byteLength !== 32) throw new Error("Stored key identities must contain 32 bytes.");
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

export function issueResumeSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function issueCapabilitySecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function decodeCapabilitySecret(secret: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new CapabilitySecretFormatError();
  const decoded = Buffer.from(secret, "base64url");
  if (decoded.byteLength !== SECRET_BYTES || decoded.toString("base64url") !== secret) {
    throw new CapabilitySecretFormatError();
  }
  return decoded;
}

export function decodeResumeSecret(secret: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new GuestSecretFormatError();
  const decoded = Buffer.from(secret, "base64url");
  if (decoded.byteLength !== SECRET_BYTES) throw new GuestSecretFormatError();
  return decoded;
}

export function constantTimeDigestEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== DIGEST_BYTES || right.byteLength !== DIGEST_BYTES) return false;
  return timingSafeEqual(left, right);
}

export class KeyLifecycleError extends Error {
  constructor(
    readonly code: "KEY_VERSION_UNAVAILABLE" | "ACTIVE_KEY_UNAVAILABLE" | "KEY_IDENTITY_MISMATCH",
    readonly version: number,
  ) {
    super(`HMAC key version ${version} is unavailable for ${code === "ACTIVE_KEY_UNAVAILABLE" ? "active use" : "verification"}.`);
    this.name = "KeyLifecycleError";
  }
}

export class GuestSecretFormatError extends Error {
  constructor() {
    super("Guest resume secrets must be canonical 256-bit base64url values.");
    this.name = "GuestSecretFormatError";
  }
}

export class CapabilitySecretFormatError extends Error {
  constructor() {
    super("Capability secrets must be canonical 256-bit base64url values.");
    this.name = "CapabilitySecretFormatError";
  }
}

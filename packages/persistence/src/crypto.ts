import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_BYTES = 32;
const DIGEST_BYTES = 32;

export interface VersionedHmacKey {
  readonly version: number;
  readonly key: Uint8Array;
}

export interface VersionedDigest {
  readonly keyVersion: number;
  readonly digest: Uint8Array;
}

export type TombstoneKind = "guest-session" | "command";

function assertKey(key: VersionedHmacKey): void {
  if (!Number.isSafeInteger(key.version) || key.version <= 0) throw new Error("HMAC key versions must be positive integers.");
  if (key.key.byteLength < SECRET_BYTES) throw new Error("HMAC keys must contain at least 256 bits.");
}

export class HmacKeyring {
  readonly active: VersionedHmacKey;
  readonly verification: ReadonlyMap<number, VersionedHmacKey>;

  constructor(active: VersionedHmacKey, previous: VersionedHmacKey | readonly VersionedHmacKey[] = []) {
    assertKey(active);
    const verificationOnly = Array.isArray(previous) ? previous : [previous];
    for (const key of verificationOnly) {
      assertKey(key);
      if (key.version === active.version) throw new Error("Active and verification-only HMAC key versions must differ.");
    }
    this.active = active;
    this.verification = new Map([active, ...verificationOnly].map((key) => [key.version, key]));
    if (this.verification.size !== verificationOnly.length + 1) throw new Error("HMAC key versions must be unique.");
  }

  digest(secret: string, keyVersion = this.active.version): VersionedDigest {
    const key = this.verification.get(keyVersion);
    if (!key) throw new Error(`HMAC key version ${keyVersion} is unavailable.`);
    return {
      keyVersion,
      digest: createHmac("sha256", key.key).update(decodeResumeSecret(secret)).digest(),
    };
  }

  candidates(secret: string): readonly VersionedDigest[] {
    return [...this.verification.values()].map((key) => this.digest(secret, key.version));
  }

  hasVersion(version: number): boolean {
    return this.verification.has(version);
  }
}

export class TombstoneKeyring {
  readonly active: VersionedHmacKey;
  readonly verification: ReadonlyMap<number, VersionedHmacKey>;

  constructor(active: VersionedHmacKey, verificationOnly: readonly VersionedHmacKey[] = []) {
    assertKey(active);
    for (const key of verificationOnly) {
      assertKey(key);
      if (key.version === active.version) throw new Error("Active and verification-only tombstone key versions must differ.");
    }
    this.active = active;
    this.verification = new Map([active, ...verificationOnly].map((key) => [key.version, key]));
    if (this.verification.size !== verificationOnly.length + 1) throw new Error("Tombstone key versions must be unique.");
  }

  digest(kind: TombstoneKind, replayKey: string, keyVersion = this.active.version): VersionedDigest {
    if (replayKey.length < 16) throw new Error("Replay keys must contain at least 16 characters of opaque material.");
    const key = this.verification.get(keyVersion);
    if (!key) throw new Error(`Tombstone key version ${keyVersion} is unavailable.`);
    return {
      keyVersion,
      digest: createHmac("sha256", key.key)
        .update(`samurai-sushi:deletion-tombstone:v1\n${kind}:${replayKey}`, "utf8")
        .digest(),
    };
  }

  hasVersion(version: number): boolean {
    return this.verification.has(version);
  }
}

export function issueResumeSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
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

export class GuestSecretFormatError extends Error {
  constructor() {
    super("Guest resume secrets must be canonical 256-bit base64url values.");
    this.name = "GuestSecretFormatError";
  }
}

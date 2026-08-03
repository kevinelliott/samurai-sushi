import { canonicalJson } from "@samurai-sushi/domain";

const KEYS = Object.freeze(["account", "canonicalOrigin", "chainId", "domain", "expiresAt", "issuedAt", "nonce",
  "permissionScopeDigest", "privacyPolicyVersion", "providerId", "publicLinkRef", "purpose", "runtimeGeneration",
  "schemaVersion", "sessionRevision"] as const);

export interface WalletLinkChallengeV1 {
  readonly domain: "samurai-sushi:receipt-wallet-link:v1";
  readonly schemaVersion: 1;
  readonly purpose: "RECEIPT_WALLET_LINK";
  readonly canonicalOrigin: string;
  readonly publicLinkRef: string;
  readonly chainId: string;
  readonly account: string;
  readonly providerId: string;
  readonly permissionScopeDigest: string;
  readonly runtimeGeneration: number;
  readonly sessionRevision: number;
  readonly privacyPolicyVersion: "receipt-wallet-privacy-v1";
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

function invalid(): never { throw new TypeError("Wallet-link challenge is invalid."); }
function exact(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value).sort();
  if (names.length !== KEYS.length || names.some((name, index) => name !== KEYS[index])) invalid();
  for (const name of names) if (!descriptors[name]?.enumerable || !("value" in descriptors[name]!)) invalid();
  return Object.fromEntries(names.map((name) => [name, descriptors[name]!.value]));
}
function match(value: unknown, pattern: RegExp, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) invalid();
  return value;
}
function coordinate(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}
function instant(value: unknown): string {
  if (typeof value !== "string") invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalid();
  return value;
}

export function parseWalletLinkChallenge(value: unknown): WalletLinkChallengeV1 {
  const row = exact(value);
  if (row.domain !== "samurai-sushi:receipt-wallet-link:v1" || row.schemaVersion !== 1
    || row.purpose !== "RECEIPT_WALLET_LINK" || row.privacyPolicyVersion !== "receipt-wallet-privacy-v1") invalid();
  const issuedAt = instant(row.issuedAt);
  const expiresAt = instant(row.expiresAt);
  if (new Date(expiresAt).getTime() !== new Date(issuedAt).getTime() + 300_000) invalid();
  return Object.freeze({
    domain: row.domain, schemaVersion: 1, purpose: row.purpose,
    canonicalOrigin: match(row.canonicalOrigin, /^https:\/\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/i),
    publicLinkRef: match(row.publicLinkRef, /^wl_[A-Za-z0-9_-]{22}$/),
    chainId: match(row.chainId, /^Net[1-9A-HJ-NP-Za-km-z]{12}$/),
    account: match(row.account, /^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/),
    providerId: match(row.providerId, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 64),
    permissionScopeDigest: match(row.permissionScopeDigest, /^[0-9a-f]{64}$/, 64),
    runtimeGeneration: coordinate(row.runtimeGeneration), sessionRevision: coordinate(row.sessionRevision),
    privacyPolicyVersion: row.privacyPolicyVersion,
    nonce: match(row.nonce, /^[A-Za-z0-9_-]{43}$/, 43), issuedAt, expiresAt,
  });
}

export function walletLinkSigningBytes(value: unknown): Uint8Array {
  const challenge = new TextEncoder().encode(canonicalJson(parseWalletLinkChallenge(value)));
  if (challenge.byteLength > 64 * 1024) invalid();
  const bytes = new Uint8Array(challenge.byteLength + 6);
  bytes[0] = 0x05; bytes[1] = 0x01;
  new DataView(bytes.buffer).setUint32(2, challenge.byteLength, false);
  bytes.set(challenge, 6);
  return bytes;
}

import { canonicalJson } from "./canonical-json";

const CLAIM_INTENT_HASH_DOMAIN = "samurai-sushi:claim-intent:v1\n";
const CLAIM_CHALLENGE_HASH_DOMAIN = "samurai-sushi:claim-challenge-hash:v1\n";
const CLAIM_CHALLENGE_DOMAIN = "samurai-sushi:guest-claim:v1";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_SHAPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const CONTENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const COSMETIC_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OPAQUE_PLAYER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TEZOS_CHAIN_ID_PATTERN = /^Net[1-9A-HJ-NP-Za-km-z]{12}$/;
const TEZOS_ACCOUNT_PATTERN = /^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/;
const RESERVED_COSMETIC_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CHALLENGE_LIFETIME_MS = 300_000;
const MAX_PROTOCOL_BYTES = 64 * 1_024;
const MAX_STRING_BYTES = 48 * 1_024;
const MAX_NODES = 1_024;
const MAX_DEPTH = 32;
const MAX_OBJECT_PROPERTIES = 128;
const MAX_ARRAY_LENGTH = 256;
const MAX_COSMETIC_SELECTIONS = 64;

export type ClaimProtocolHash = `sha256:${string}`;

export interface CreatePlayerClaimIntentV1 {
  readonly claimId: string;
  readonly guestClaimCommitment: string;
  readonly createPlayer: true;
  readonly guestRevision: number;
  readonly idempotencyKey: string;
  readonly contentVersion: string;
  readonly cosmeticSelections: Readonly<Record<string, string>>;
}

export interface ExistingPlayerClaimIntentV1 {
  readonly claimId: string;
  readonly guestClaimCommitment: string;
  readonly targetPlayerId: string;
  readonly createPlayer: false;
  readonly guestRevision: number;
  readonly playerRevision: number;
  readonly idempotencyKey: string;
  readonly contentVersion: string;
  readonly cosmeticSelections: Readonly<Record<string, string>>;
}

export type ClaimIntentV1 = CreatePlayerClaimIntentV1 | ExistingPlayerClaimIntentV1;

/** Canonical challenge body; wallets sign walletSigningBytes, not these raw JSON bytes. */
export interface ClaimChallengeV1 {
  readonly domain: typeof CLAIM_CHALLENGE_DOMAIN;
  readonly schemaVersion: 1;
  readonly origin: string;
  readonly chainId: string;
  readonly account: string;
  readonly claimIntentHash: ClaimProtocolHash;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Signature-free canonical challenge body used to construct walletSigningBytes. */
export type ClaimChallengeToSignV1 = ClaimChallengeV1;

export type ClaimProtocolErrorCode = "INVALID_CLAIM_PROTOCOL";

/** Public-safe: it never includes attacker-controlled field values or paths. */
export class ClaimProtocolError extends Error {
  readonly code: ClaimProtocolErrorCode = "INVALID_CLAIM_PROTOCOL";

  constructor() {
    super("The account-claim protocol payload is invalid.");
    this.name = "ClaimProtocolError";
  }
}

function invalid(): never {
  throw new ClaimProtocolError();
}

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) invalid();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid();
    }
  }
}

interface PreflightFrame {
  readonly value: unknown;
  readonly depth: number;
  readonly exiting: boolean;
}

function preflight(input: unknown): void {
  const stack: PreflightFrame[] = [{ value: input, depth: 0, exiting: false }];
  const active = new Set<object>();
  const encoder = new TextEncoder();
  let nodes = 0;
  let stringBytes = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const value = frame.value;
    if (frame.exiting) {
      active.delete(value as object);
      continue;
    }

    nodes += 1;
    if (nodes > MAX_NODES || frame.depth > MAX_DEPTH) invalid();
    if (typeof value === "string") {
      assertUnicode(value);
      stringBytes += encoder.encode(value).byteLength;
      if (stringBytes > MAX_STRING_BYTES) invalid();
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0) || !Number.isSafeInteger(value)) invalid();
      continue;
    }
    if (value === null || typeof value === "boolean") continue;
    if (!value || typeof value !== "object") invalid();
    if (active.has(value)) invalid();

    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) invalid();
    if (Object.getOwnPropertySymbols(value).length > 0) invalid();

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(value);
    if (names.length > MAX_OBJECT_PROPERTIES) invalid();
    if (Array.isArray(value) && value.length > MAX_ARRAY_LENGTH) invalid();

    active.add(value);
    stack.push({ value, depth: frame.depth, exiting: true });
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
        stack.push({ value: descriptor.value, depth: frame.depth + 1, exiting: false });
      }
      if (names.length !== value.length + 1 || !names.includes("length")) invalid();
      continue;
    }

    for (let index = names.length - 1; index >= 0; index -= 1) {
      const name = names[index];
      if (name === undefined) invalid();
      assertUnicode(name);
      stringBytes += encoder.encode(name).byteLength;
      if (stringBytes > MAX_STRING_BYTES) invalid();
      const descriptor = descriptors[name];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
      stack.push({ value: descriptor.value, depth: frame.depth + 1, exiting: false });
    }
  }
}

function detachedObject(input: unknown): Record<string, unknown> {
  preflight(input);
  let encoded: string;
  try {
    encoded = canonicalJson(input);
  } catch {
    invalid();
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_PROTOCOL_BYTES) invalid();
  const detached = JSON.parse(encoded) as unknown;
  if (!detached || typeof detached !== "object" || Array.isArray(detached)) invalid();
  return detached as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalid();
}

function nonnegativeRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function idempotencyKey(value: unknown): string {
  if (
    typeof value !== "string"
    || (UUID_SHAPE_PATTERN.test(value) && !UUID_V4_PATTERN.test(value))
    || (!UUID_V4_PATTERN.test(value) && !IDEMPOTENCY_BASE64URL_PATTERN.test(value))
  ) invalid();
  if (!UUID_V4_PATTERN.test(value)) {
    let binary: string;
    try {
      binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4));
    } catch {
      invalid();
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let roundTrip = "";
    for (const byte of bytes) roundTrip += String.fromCharCode(byte);
    roundTrip = btoa(roundTrip).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    if (bytes.byteLength < 16 || roundTrip !== value) invalid();
  }
  return value;
}

function contentVersion(value: unknown): string {
  if (typeof value !== "string" || !CONTENT_VERSION_PATTERN.test(value)) invalid();
  return value;
}

function base64url32(value: unknown): string {
  if (typeof value !== "string" || !BASE64URL_32_PATTERN.test(value)) invalid();
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=");
  } catch {
    invalid();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let roundTrip = "";
  for (const byte of bytes) roundTrip += String.fromCharCode(byte);
  roundTrip = btoa(roundTrip).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (bytes.byteLength !== 32 || roundTrip !== value) invalid();
  return value;
}

function cosmetics(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const entries = Object.entries(value);
  if (entries.length > MAX_COSMETIC_SELECTIONS) invalid();
  const result: Record<string, string> = {};
  for (const [key, option] of entries) {
    if (
      RESERVED_COSMETIC_KEYS.has(key)
      || key.length > 64
      || !COSMETIC_IDENTIFIER_PATTERN.test(key)
      || typeof option !== "string"
      || option.length > 64
      || !COSMETIC_IDENTIFIER_PATTERN.test(option)
    ) invalid();
    result[key] = option;
  }
  return Object.freeze(result);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function parseClaimIntent(input: unknown): ClaimIntentV1 {
  const intent = detachedObject(input);
  if (typeof intent.createPlayer !== "boolean") invalid();
  exactKeys(intent, intent.createPlayer
    ? ["claimId", "guestClaimCommitment", "createPlayer", "guestRevision", "idempotencyKey", "contentVersion", "cosmeticSelections"]
    : ["claimId", "guestClaimCommitment", "targetPlayerId", "createPlayer", "guestRevision", "playerRevision", "idempotencyKey", "contentVersion", "cosmeticSelections"]);
  if (typeof intent.claimId !== "string" || !UUID_V4_PATTERN.test(intent.claimId)) invalid();
  const common = {
    claimId: intent.claimId,
    guestClaimCommitment: base64url32(intent.guestClaimCommitment),
    guestRevision: nonnegativeRevision(intent.guestRevision),
    idempotencyKey: idempotencyKey(intent.idempotencyKey),
    contentVersion: contentVersion(intent.contentVersion),
    cosmeticSelections: cosmetics(intent.cosmeticSelections),
  };
  if (intent.createPlayer) return deepFreeze({ ...common, createPlayer: true });
  if (typeof intent.targetPlayerId !== "string" || !OPAQUE_PLAYER_ID_PATTERN.test(intent.targetPlayerId)) invalid();
  return deepFreeze({
    ...common,
    targetPlayerId: intent.targetPlayerId,
    createPlayer: false,
    playerRevision: nonnegativeRevision(intent.playerRevision),
  });
}

function exactUtcMilliseconds(value: unknown): string {
  if (typeof value !== "string") invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalid();
  return value;
}

function canonicalOrigin(value: unknown): string {
  if (typeof value !== "string") invalid();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid();
  }
  const isSecure = parsed.protocol === "https:";
  const isLoopback = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (
    (!isSecure && !isLoopback)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.origin !== value
  ) invalid();
  return value;
}

/** Validates bounded canonical account/chain text shape, not Base58Check or key possession. */
export function parseClaimChallenge(input: unknown): ClaimChallengeV1 {
  const challenge = detachedObject(input);
  exactKeys(challenge, ["domain", "schemaVersion", "origin", "chainId", "account", "claimIntentHash", "nonce", "issuedAt", "expiresAt"]);
  if (challenge.domain !== CLAIM_CHALLENGE_DOMAIN || challenge.schemaVersion !== 1) invalid();
  if (typeof challenge.chainId !== "string" || !TEZOS_CHAIN_ID_PATTERN.test(challenge.chainId)) invalid();
  if (typeof challenge.account !== "string" || !TEZOS_ACCOUNT_PATTERN.test(challenge.account)) invalid();
  if (typeof challenge.claimIntentHash !== "string" || !SHA256_PATTERN.test(challenge.claimIntentHash)) invalid();
  const issuedAt = exactUtcMilliseconds(challenge.issuedAt);
  const expiresAt = exactUtcMilliseconds(challenge.expiresAt);
  if (new Date(expiresAt).getTime() - new Date(issuedAt).getTime() !== CHALLENGE_LIFETIME_MS) invalid();
  return deepFreeze({
    domain: CLAIM_CHALLENGE_DOMAIN,
    schemaVersion: 1,
    origin: canonicalOrigin(challenge.origin),
    chainId: challenge.chainId,
    account: challenge.account,
    claimIntentHash: challenge.claimIntentHash as ClaimProtocolHash,
    nonce: base64url32(challenge.nonce),
    issuedAt,
    expiresAt,
  });
}

function canonicalBytes(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  if (bytes.byteLength > MAX_PROTOCOL_BYTES) invalid();
  return bytes;
}

export function canonicalClaimIntentBytes(input: unknown): Uint8Array {
  return canonicalBytes(parseClaimIntent(input));
}

export function canonicalClaimChallengeBytes(input: unknown): Uint8Array {
  return canonicalBytes(parseClaimChallenge(input));
}

/** Exact bytes passed to a wallet with SigningType.MICHELINE. */
export function walletSigningBytes(input: unknown): Uint8Array {
  const challenge = canonicalClaimChallengeBytes(input);
  const result = new Uint8Array(6 + challenge.byteLength);
  result[0] = 0x05;
  result[1] = 0x01;
  new DataView(result.buffer).setUint32(2, challenge.byteLength, false);
  result.set(challenge, 6);
  return result;
}

export function walletSigningHex(input: unknown): string {
  let hex = "";
  for (const byte of walletSigningBytes(input)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function concatDomain(domain: string, bytes: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(domain);
  const result = new Uint8Array(prefix.byteLength + bytes.byteLength);
  result.set(prefix);
  result.set(bytes, prefix.byteLength);
  return result;
}

function cryptoProvider(): Crypto {
  const provider = globalThis.crypto;
  if (!provider?.subtle) invalid();
  return provider;
}

async function sha256(bytes: Uint8Array): Promise<ClaimProtocolHash> {
  const source = bytes.slice().buffer;
  const digest = new Uint8Array(await cryptoProvider().subtle.digest("SHA-256", source));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

export function claimIntentHashPreimage(input: unknown): Uint8Array {
  return concatDomain(CLAIM_INTENT_HASH_DOMAIN, canonicalClaimIntentBytes(input));
}

export async function hashClaimIntent(input: unknown): Promise<ClaimProtocolHash> {
  return sha256(claimIntentHashPreimage(input));
}

export function claimChallengeHashPreimage(input: unknown): Uint8Array {
  return concatDomain(CLAIM_CHALLENGE_HASH_DOMAIN, canonicalClaimChallengeBytes(input));
}

export async function hashClaimChallenge(input: unknown): Promise<ClaimProtocolHash> {
  return sha256(claimChallengeHashPreimage(input));
}

export function parseCanonicalClaimIntentBytes(bytes: Uint8Array): ClaimIntentV1 {
  return parseCanonicalBytes(bytes, parseClaimIntent);
}

export function parseCanonicalClaimChallengeBytes(bytes: Uint8Array): ClaimChallengeV1 {
  return parseCanonicalBytes(bytes, parseClaimChallenge);
}

function parseCanonicalBytes<T>(bytes: Uint8Array, parser: (input: unknown) => T): T {
  if (bytes.byteLength > MAX_PROTOCOL_BYTES) invalid();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid();
  }
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    invalid();
  }
  const result = parser(input);
  if (canonicalJson(result) !== text) invalid();
  return result;
}

export const claimProtocolProfile = Object.freeze({
  claimIntentHashDomain: CLAIM_INTENT_HASH_DOMAIN,
  claimChallengeHashDomain: CLAIM_CHALLENGE_HASH_DOMAIN,
  challengeDomain: CLAIM_CHALLENGE_DOMAIN,
  walletSigningType: "MICHELINE",
  challengeLifetimeMs: CHALLENGE_LIFETIME_MS,
  maxProtocolBytes: MAX_PROTOCOL_BYTES,
  maxNodes: MAX_NODES,
  maxDepth: MAX_DEPTH,
  maxCosmeticSelections: MAX_COSMETIC_SELECTIONS,
});

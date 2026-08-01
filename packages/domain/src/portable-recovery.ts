import { canonicalJson } from "./canonical-json";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const KEY_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REFS = 2_048;
const MAX_ENVELOPE_BYTES = 256 * 1_024;
const CONTENT_KINDS = new Set(["species", "ingredient", "cut-style", "component", "family", "dish", "recipe", "variant", "seasonality-rule", "pack"]);

export interface PortableSaveContentRefV1 {
  readonly kind: string;
  readonly id: string;
  readonly version: number;
  readonly contentHash: `sha256:${string}`;
}

export interface PortableSaveContentV1 {
  readonly contentVersion: string;
  readonly checkpointSchemaVersion: number;
  readonly pack: {
    readonly id: string;
    readonly version: number;
    readonly contentHash: `sha256:${string}`;
    readonly contentManifestHash: `sha256:${string}`;
    readonly artAssetMapHash: `sha256:${string}`;
  };
  readonly refs: readonly PortableSaveContentRefV1[];
  readonly savePayloadHash: `sha256:${string}`;
}

export interface PortableSaveClaimsV1 {
  readonly domain: "samurai-sushi:portable-save:v1";
  readonly schemaVersion: 1;
  readonly exportId: string;
  readonly subjectRevision: number;
  readonly unlinkableClaimCommitment: string;
  readonly content: PortableSaveContentV1;
  readonly expiresAt: string;
  readonly integrity: {
    readonly keyVersion: number;
    readonly keyIdentity: `sha256:${string}`;
  };
}

export interface PortableSaveEnvelopeV1 extends PortableSaveClaimsV1 {
  readonly integrity: PortableSaveClaimsV1["integrity"] & {
    readonly tag: string;
  };
}

export class PortableRecoveryShapeError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path} ${message}`);
    this.name = "PortableRecoveryShapeError";
  }
}

function invalid(path: string, message: string): never {
  throw new PortableRecoveryShapeError(path, message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object.");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(path, `must contain exactly: ${wanted.join(", ")}.`);
  }
}

function positiveVersion(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(path, "must be a positive safe integer.");
  return value as number;
}

function nonnegativeRevision(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(path, "must be a non-negative safe integer.");
  return value as number;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) invalid(path, "must be a bounded identifier.");
  return value;
}

function contentVersion(value: unknown, path: string): string {
  if (typeof value !== "string" || !CONTENT_VERSION_PATTERN.test(value)) invalid(path, "must be a stable content version.");
  return value;
}

function hash(value: unknown, path: string): `sha256:${string}` {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) invalid(path, "must be a lowercase SHA-256 digest.");
  return value as `sha256:${string}`;
}

function exactUtcMilliseconds(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, "must be an exact UTC timestamp.");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid(path, "must use exact UTC millisecond form.");
  }
  return value;
}

function canonicalBase64url32(value: unknown, path: string): string {
  if (typeof value !== "string" || !BASE64URL_32_PATTERN.test(value)) {
    invalid(path, "must contain 32 unpadded base64url bytes.");
  }
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=");
  } catch {
    invalid(path, "must contain 32 unpadded base64url bytes.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let roundTrip = "";
  for (const byte of bytes) roundTrip += String.fromCharCode(byte);
  roundTrip = btoa(roundTrip).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (bytes.byteLength !== 32 || roundTrip !== value) invalid(path, "must use canonical base64url.");
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function assertBoundedInput(input: unknown): void {
  const pending: unknown[] = [input];
  const seen = new Set<object>();
  let nodes = 0;
  let stringCodeUnits = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    nodes += 1;
    if (nodes > 8_192) invalid("$envelope", "contains too many values.");
    if (typeof value === "string") {
      stringCodeUnits += value.length;
      if (stringCodeUnits > MAX_ENVELOPE_BYTES) invalid("$envelope", "contains too much string data.");
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) invalid("$envelope", "must not contain a cycle.");
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_REFS) invalid("$envelope", `must not contain arrays longer than ${MAX_REFS}.`);
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) invalid("$envelope", "must not contain sparse arrays.");
        pending.push(value[index]);
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) invalid("$envelope", "must contain only plain objects.");
    let properties = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      properties += 1;
      if (properties > 128) invalid("$envelope", "contains an object with too many properties.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid("$envelope", "must not contain accessors.");
      pending.push(descriptor.value);
    }
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.getOwnPropertyNames(value).length !== properties) {
      invalid("$envelope", "must contain only enumerable string properties.");
    }
  }
}

export function portableSaveClaims(envelope: PortableSaveEnvelopeV1): PortableSaveClaimsV1 {
  const validated = parsePortableSaveEnvelope(envelope);
  const claims = {
    domain: validated.domain,
    schemaVersion: validated.schemaVersion,
    exportId: validated.exportId,
    subjectRevision: validated.subjectRevision,
    unlinkableClaimCommitment: validated.unlinkableClaimCommitment,
    content: validated.content,
    expiresAt: validated.expiresAt,
    integrity: {
      keyVersion: validated.integrity.keyVersion,
      keyIdentity: validated.integrity.keyIdentity,
    },
  };
  return deepFreeze(JSON.parse(canonicalJson(claims)) as PortableSaveClaimsV1);
}

export function parsePortableSaveEnvelope(input: unknown): PortableSaveEnvelopeV1 {
  assertBoundedInput(input);
  let canonical: string;
  let detached: unknown;
  try {
    canonical = canonicalJson(input);
    if (new TextEncoder().encode(canonical).byteLength > MAX_ENVELOPE_BYTES) {
      invalid("$envelope", `must not exceed ${MAX_ENVELOPE_BYTES} UTF-8 bytes.`);
    }
    detached = JSON.parse(canonical) as unknown;
  } catch (error) {
    if (error instanceof PortableRecoveryShapeError) throw error;
    invalid("$", error instanceof Error ? error.message : "must be canonical JSON.");
  }
  const envelope = object(detached, "$envelope");
  exactKeys(envelope, ["content", "domain", "expiresAt", "exportId", "integrity", "schemaVersion", "subjectRevision", "unlinkableClaimCommitment"], "$envelope");
  if (envelope.domain !== "samurai-sushi:portable-save:v1") invalid("$envelope.domain", "is unsupported.");
  if (envelope.schemaVersion !== 1) invalid("$envelope.schemaVersion", "is unsupported.");
  if (typeof envelope.exportId !== "string" || !UUID_V4_PATTERN.test(envelope.exportId)) {
    invalid("$envelope.exportId", "must be a canonical UUIDv4.");
  }
  const unlinkableClaimCommitment = canonicalBase64url32(
    envelope.unlinkableClaimCommitment,
    "$envelope.unlinkableClaimCommitment",
  );
  const content = object(envelope.content, "$envelope.content");
  exactKeys(content, ["checkpointSchemaVersion", "contentVersion", "pack", "refs", "savePayloadHash"], "$envelope.content");
  const pack = object(content.pack, "$envelope.content.pack");
  exactKeys(pack, ["artAssetMapHash", "contentHash", "contentManifestHash", "id", "version"], "$envelope.content.pack");
  if (!Array.isArray(content.refs) || content.refs.length > MAX_REFS) invalid("$envelope.content.refs", `must contain at most ${MAX_REFS} entries.`);
  const refs = content.refs.map((entry, index): PortableSaveContentRefV1 => {
    const ref = object(entry, `$envelope.content.refs[${index}]`);
    exactKeys(ref, ["contentHash", "id", "kind", "version"], `$envelope.content.refs[${index}]`);
    return {
      kind: (() => {
        const kind = identifier(ref.kind, `$envelope.content.refs[${index}].kind`);
        if (!CONTENT_KINDS.has(kind)) invalid(`$envelope.content.refs[${index}].kind`, "is not a supported content kind.");
        return kind;
      })(),
      id: identifier(ref.id, `$envelope.content.refs[${index}].id`),
      version: positiveVersion(ref.version, `$envelope.content.refs[${index}].version`),
      contentHash: hash(ref.contentHash, `$envelope.content.refs[${index}].contentHash`),
    };
  });
  const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const compareRef = (left: PortableSaveContentRefV1, right: PortableSaveContentRefV1): number => (
    compareText(left.kind, right.kind) || compareText(left.id, right.id) || left.version - right.version
  );
  if (refs.some((ref, index) => index > 0 && compareRef(refs[index - 1]!, ref) >= 0)) {
    invalid("$envelope.content.refs", "must be strictly sorted and unique by kind, id, and version.");
  }
  const integrity = object(envelope.integrity, "$envelope.integrity");
  exactKeys(integrity, ["keyIdentity", "keyVersion", "tag"], "$envelope.integrity");
  if (typeof integrity.keyIdentity !== "string" || !KEY_IDENTITY_PATTERN.test(integrity.keyIdentity)) {
    invalid("$envelope.integrity.keyIdentity", "must be a lowercase SHA-256 key identity.");
  }
  const integrityTag = canonicalBase64url32(integrity.tag, "$envelope.integrity.tag");
  return deepFreeze({
    domain: "samurai-sushi:portable-save:v1",
    schemaVersion: 1,
    exportId: envelope.exportId,
    subjectRevision: nonnegativeRevision(envelope.subjectRevision, "$envelope.subjectRevision"),
    unlinkableClaimCommitment,
    content: {
      contentVersion: contentVersion(content.contentVersion, "$envelope.content.contentVersion"),
      checkpointSchemaVersion: positiveVersion(content.checkpointSchemaVersion, "$envelope.content.checkpointSchemaVersion"),
      pack: {
        id: identifier(pack.id, "$envelope.content.pack.id"),
        version: positiveVersion(pack.version, "$envelope.content.pack.version"),
        contentHash: hash(pack.contentHash, "$envelope.content.pack.contentHash"),
        contentManifestHash: hash(pack.contentManifestHash, "$envelope.content.pack.contentManifestHash"),
        artAssetMapHash: hash(pack.artAssetMapHash, "$envelope.content.pack.artAssetMapHash"),
      },
      refs,
      savePayloadHash: hash(content.savePayloadHash, "$envelope.content.savePayloadHash"),
    },
    expiresAt: exactUtcMilliseconds(envelope.expiresAt, "$envelope.expiresAt"),
    integrity: {
      keyVersion: positiveVersion(integrity.keyVersion, "$envelope.integrity.keyVersion"),
      keyIdentity: integrity.keyIdentity as `sha256:${string}`,
      tag: integrityTag,
    },
  });
}

export function canonicalPortableSaveEnvelopeBytes(input: unknown): Uint8Array {
  const envelope = parsePortableSaveEnvelope(input);
  const bytes = new TextEncoder().encode(canonicalJson(envelope));
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) invalid("$envelope", `must not exceed ${MAX_ENVELOPE_BYTES} UTF-8 bytes.`);
  return bytes;
}

export function parseCanonicalPortableSaveEnvelopeBytes(bytes: Uint8Array): PortableSaveEnvelopeV1 {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) invalid("$envelope", `must not exceed ${MAX_ENVELOPE_BYTES} UTF-8 bytes.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("$envelope", "must be valid UTF-8.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    invalid("$envelope", "must be valid JSON.");
  }
  const envelope = parsePortableSaveEnvelope(parsed);
  if (canonicalJson(envelope) !== text) invalid("$envelope", "must use the exact canonical JSON encoding.");
  return envelope;
}

export const portableSaveLimits = Object.freeze({ maxEnvelopeBytes: MAX_ENVELOPE_BYTES, maxRefs: MAX_REFS });

import { randomBytes } from "node:crypto";
import { hashCommandPayload, parseCommandPayloadHash } from "./canonical";
import { PersistenceDomainError } from "./errors";
import type {
  CommandEnvelope,
  IdempotencyKey,
  JsonValue,
  StoredCommandResult,
  StoredCommandResponse,
  SubjectRef,
} from "./model";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_SHAPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const COMMAND_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*$/;
const CONTENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const ENVELOPE_KEYS = [
  "commandName",
  "contentVersion",
  "expectedRevision",
  "idempotencyKey",
  "payload",
  "payloadHash",
  "schemaVersion",
  "subject",
] as const;

function invalid(path: string, message: string): never {
  throw new PersistenceDomainError("INVALID_COMMAND_SHAPE", `${path} ${message}`);
}

function strictObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object.");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "must be a plain object.");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(path, `must contain exactly: ${wanted.join(", ")}.`);
  }
}

function parseSubject(value: unknown): SubjectRef {
  const subject = strictObject(value, "$.subject");
  if (subject.kind === "guest") {
    exactKeys(subject, ["guestSessionId", "kind"], "$.subject");
    if (typeof subject.guestSessionId !== "string" || !SUBJECT_ID_PATTERN.test(subject.guestSessionId)) {
      invalid("$.subject.guestSessionId", "must be a stable opaque identifier.");
    }
    return { kind: "guest", guestSessionId: subject.guestSessionId };
  }
  if (subject.kind === "player") {
    exactKeys(subject, ["kind", "playerId"], "$.subject");
    if (typeof subject.playerId !== "string" || !SUBJECT_ID_PATTERN.test(subject.playerId)) {
      invalid("$.subject.playerId", "must be a stable opaque identifier.");
    }
    return { kind: "player", playerId: subject.playerId };
  }
  invalid("$.subject.kind", "must be guest or player.");
}

export function parseIdempotencyKey(value: unknown): IdempotencyKey {
  if (
    typeof value !== "string"
    || (UUID_SHAPE_PATTERN.test(value) && !UUID_V4_PATTERN.test(value))
    || (!UUID_V4_PATTERN.test(value) && !BASE64URL_PATTERN.test(value))
  ) {
    invalid("$.idempotencyKey", "must be a canonical UUIDv4 or at least 128 bits of unpadded base64url entropy.");
  }
  return value as IdempotencyKey;
}

export function generateIdempotencyKey(): IdempotencyKey {
  return randomBytes(32).toString("base64url") as IdempotencyKey;
}

export function subjectIdentity(subject: SubjectRef): { readonly subjectKind: SubjectRef["kind"]; readonly subjectId: string } {
  return subject.kind === "guest"
    ? { subjectKind: subject.kind, subjectId: subject.guestSessionId }
    : { subjectKind: subject.kind, subjectId: subject.playerId };
}

export function sameSubject(left: SubjectRef, right: SubjectRef): boolean {
  const leftIdentity = subjectIdentity(left);
  const rightIdentity = subjectIdentity(right);
  return leftIdentity.subjectKind === rightIdentity.subjectKind && leftIdentity.subjectId === rightIdentity.subjectId;
}

export function validateCommandEnvelope(input: unknown): CommandEnvelope {
  const envelope = strictObject(input, "$");
  exactKeys(envelope, ENVELOPE_KEYS, "$");

  if (envelope.schemaVersion !== 1) invalid("$.schemaVersion", "must equal 1.");
  if (typeof envelope.commandName !== "string" || !COMMAND_NAME_PATTERN.test(envelope.commandName)) {
    invalid("$.commandName", "must be a stable command identifier.");
  }
  if (!Number.isSafeInteger(envelope.expectedRevision) || (envelope.expectedRevision as number) < 0) {
    invalid("$.expectedRevision", "must be a non-negative safe integer.");
  }
  if (typeof envelope.contentVersion !== "string" || !CONTENT_VERSION_PATTERN.test(envelope.contentVersion)) {
    invalid("$.contentVersion", "must be a stable non-empty version identifier.");
  }

  const payloadHash = parseCommandPayloadHash(envelope.payloadHash);
  const computedHash = hashCommandPayload(envelope.payload);
  if (payloadHash !== computedHash) invalid("$.payloadHash", "does not match the canonical payload.");

  return {
    schemaVersion: 1,
    commandName: envelope.commandName,
    subject: parseSubject(envelope.subject),
    idempotencyKey: parseIdempotencyKey(envelope.idempotencyKey),
    expectedRevision: envelope.expectedRevision as number,
    contentVersion: envelope.contentVersion,
    payload: envelope.payload as JsonValue,
    payloadHash,
  };
}

export function createCommandEnvelope<TPayload extends JsonValue>(input: Omit<CommandEnvelope<TPayload>, "payloadHash">): CommandEnvelope<TPayload> {
  return validateCommandEnvelope({ ...input, payloadHash: hashCommandPayload(input.payload) }) as CommandEnvelope<TPayload>;
}

export function assertRetryMatches<TResponse extends JsonValue>(
  retryInput: unknown,
  stored: StoredCommandResult<TResponse>,
): StoredCommandResponse<TResponse> {
  const retry = validateCommandEnvelope(retryInput);
  if (!sameSubject(retry.subject, stored.subject) || retry.idempotencyKey !== stored.idempotencyKey) {
    invalid("$", "does not address the stored idempotency scope.");
  }
  if (
    retry.commandName !== stored.commandName
    || retry.expectedRevision !== stored.expectedRevision
    || retry.contentVersion !== stored.contentVersion
    || retry.payloadHash !== stored.payloadHash
  ) {
    throw new PersistenceDomainError(
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      "The idempotency key was already used for a different canonical command.",
    );
  }
  return stored.response;
}

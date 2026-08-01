import { createHash } from "node:crypto";
import { canonicalJson } from "@samurai-sushi/domain";
import type { JsonObject, JsonValue } from "@samurai-sushi/domain";
import type { PersistenceDecision } from "./domain-adapter";
import { PersistenceError } from "./errors";

const RESULT_HASH_DOMAIN = "samurai-sushi:command-response:v1\n";
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const EVENT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*$/;

function invalid(path: string, message: string): never {
  throw new PersistenceError("INVALID_DECISION_SHAPE", `${path} ${message}`);
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

export interface CanonicalDecision<Checkpoint extends JsonObject, ResponsePayload extends JsonValue> {
  readonly decision: PersistenceDecision<Checkpoint, ResponsePayload>;
  readonly canonicalBytes: string;
  readonly resultHash: `sha256:${string}`;
}

export function hashPersistenceResponse(schemaVersion: number, payload: JsonValue): `sha256:${string}` {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
    invalid("$response.schemaVersion", "must be a positive safe integer.");
  }
  const responseBytes = canonicalJson({ schemaVersion, payload });
  return `sha256:${createHash("sha256").update(RESULT_HASH_DOMAIN).update(responseBytes).digest("hex")}`;
}

export function canonicalizeDecision<Checkpoint extends JsonObject, ResponsePayload extends JsonValue>(
  input: unknown,
): CanonicalDecision<Checkpoint, ResponsePayload> {
  let canonicalBytes: string;
  try {
    canonicalBytes = canonicalJson(input);
  } catch (error) {
    throw new PersistenceError(
      "INVALID_DECISION_SHAPE",
      error instanceof Error ? error.message : "The decision is not canonical JSON.",
    );
  }
  const detached = JSON.parse(canonicalBytes) as unknown;
  const decision = object(detached, "$decision");
  exactKeys(decision, ["checkpoint", "checkpointSchemaVersion", "event", "response"], "$decision");
  const checkpoint = object(decision.checkpoint, "$decision.checkpoint") as Checkpoint;
  const event = object(decision.event, "$decision.event");
  exactKeys(event, ["eventId", "eventType", "payload", "schemaVersion"], "$decision.event");
  if (typeof event.eventId !== "string" || !EVENT_ID_PATTERN.test(event.eventId)) {
    invalid("$decision.event.eventId", "must be a stable opaque event identifier.");
  }
  if (typeof event.eventType !== "string" || !EVENT_TYPE_PATTERN.test(event.eventType)) {
    invalid("$decision.event.eventType", "must be a stable event identifier.");
  }
  const eventPayload = object(event.payload, "$decision.event.payload") as JsonObject;
  const response = object(decision.response, "$decision.response");
  exactKeys(response, ["payload", "schemaVersion"], "$decision.response");
  const snapshot: PersistenceDecision<Checkpoint, ResponsePayload> = {
    checkpointSchemaVersion: positiveVersion(decision.checkpointSchemaVersion, "$decision.checkpointSchemaVersion"),
    checkpoint,
    event: {
      eventId: event.eventId,
      eventType: event.eventType,
      schemaVersion: positiveVersion(event.schemaVersion, "$decision.event.schemaVersion"),
      payload: eventPayload,
    },
    response: {
      schemaVersion: positiveVersion(response.schemaVersion, "$decision.response.schemaVersion"),
      payload: response.payload as ResponsePayload,
    },
  };
  const resultHash = hashPersistenceResponse(snapshot.response.schemaVersion, snapshot.response.payload);
  return { decision: snapshot, canonicalBytes, resultHash };
}

export const persistenceResponseHashDomain = RESULT_HASH_DOMAIN;

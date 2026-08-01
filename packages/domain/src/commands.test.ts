import { describe, expect, it } from "vitest";
import {
  assertRetryMatches,
  canonicalCommandPayloadBytes,
  canonicalJson,
  createCommandEnvelope,
  disconnectedFailure,
  generateIdempotencyKey,
  hashCommandPayload,
  parseIdempotencyKey,
  PersistenceDomainError,
  revisionConflict,
  validateCommandEnvelope,
} from "./index";
import type { CommandEnvelope, JsonValue, StoredCommandResult } from "./index";

const guestSubject = { kind: "guest", guestSessionId: "guest_01JABCDEF23456789" } as const;

function envelope(payload: JsonValue = { orderId: "order-1", step: 2 }): CommandEnvelope {
  return createCommandEnvelope({
    schemaVersion: 1,
    commandName: "PerformStep",
    subject: guestSubject,
    idempotencyKey: parseIdempotencyKey("018f1f34-7f92-4ac1-8d77-38edc9327a61"),
    expectedRevision: 7,
    contentVersion: "mvp@1",
    payload,
  });
}

function stored(command: CommandEnvelope): StoredCommandResult {
  return {
    subject: command.subject,
    idempotencyKey: command.idempotencyKey,
    commandName: command.commandName,
    expectedRevision: command.expectedRevision,
    contentVersion: command.contentVersion,
    payloadHash: command.payloadHash,
    committedRevision: 8,
    resultHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    response: { schemaVersion: 1, payload: { accepted: true } },
  };
}

function expectFailure(code: string, action: () => unknown): void {
  try {
    action();
    throw new Error("Expected the action to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(PersistenceDomainError);
    expect(error).toMatchObject({ code });
  }
}

describe("canonical command hashing", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = { z: 3, nested: { beta: true, alpha: "rice" }, list: [2, 1] };
    const right = { list: [2, 1], nested: { alpha: "rice", beta: true }, z: 3 };

    expect(canonicalJson(left)).toBe('{"list":[2,1],"nested":{"alpha":"rice","beta":true},"z":3}');
    expect(hashCommandPayload(left)).toBe(hashCommandPayload(right));
    expect(new TextDecoder().decode(canonicalCommandPayloadBytes(left))).toBe(
      'samurai-sushi:command:v1\n{"list":[2,1],"nested":{"alpha":"rice","beta":true},"z":3}',
    );
  });

  it("changes the hash when canonical payload meaning changes", () => {
    expect(hashCommandPayload({ step: 1 })).not.toBe(hashCommandPayload({ step: 2 }));
    expect(hashCommandPayload({ steps: [1, 2] })).not.toBe(hashCommandPayload({ steps: [2, 1] }));
  });

  it.each([
    ["unsafe integer", { value: Number.MAX_SAFE_INTEGER + 1 }],
    ["undefined property", { value: undefined }],
    ["undefined array item", [undefined]],
    ["negative zero", { value: -0 }],
    ["non-finite number", { value: Number.POSITIVE_INFINITY }],
    ["bigint", { value: 1n }],
    ["non-plain object", { value: new Date(0) }],
  ])("rejects %s", (_label, value) => {
    expectFailure("INVALID_COMMAND_SHAPE", () => canonicalJson(value));
  });

  it("rejects cycles and sparse arrays", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(1) as unknown[];
    expectFailure("INVALID_COMMAND_SHAPE", () => canonicalJson(cycle));
    expectFailure("INVALID_COMMAND_SHAPE", () => canonicalJson(sparse));
  });
});

describe("command envelope validation", () => {
  it("creates and validates a strict envelope", () => {
    const command = envelope();
    expect(validateCommandEnvelope(command)).toEqual(command);
    expect(command.payloadHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("generates and accepts 256-bit base64url idempotency keys", () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parseIdempotencyKey(key)).toBe(key);
  });

  it.each(["retry", "123456789012345678901", "018f1f34-7f92-1ac1-8d77-38edc9327a61", "not base64url!!!!!!!!!"])(
    "rejects a low-entropy or malformed idempotency key: %s",
    (key) => expectFailure("INVALID_COMMAND_SHAPE", () => parseIdempotencyKey(key)),
  );

  it("rejects payload hash drift and unknown envelope fields", () => {
    const command = envelope();
    expectFailure("INVALID_COMMAND_SHAPE", () => validateCommandEnvelope({ ...command, payload: { step: 3 } }));
    expectFailure("INVALID_COMMAND_SHAPE", () => validateCommandEnvelope({ ...command, extra: true }));
  });

  it("rejects unsafe revisions and invalid payload values", () => {
    const command = envelope();
    expectFailure("INVALID_COMMAND_SHAPE", () => validateCommandEnvelope({ ...command, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }));
    expectFailure("INVALID_COMMAND_SHAPE", () => createCommandEnvelope({ ...command, payload: { invalid: undefined } as never }));
  });
});

describe("retry binding and stable failures", () => {
  it("returns the stored response for the exact canonical retry", () => {
    const first = envelope({ first: 1, second: 2 });
    const retry = createCommandEnvelope({ ...first, payload: { second: 2, first: 1 } });
    expect(assertRetryMatches(retry, stored(first))).toEqual({ schemaVersion: 1, payload: { accepted: true } });
  });

  it.each([
    ["payload", (command: CommandEnvelope) => createCommandEnvelope({ ...command, payload: { changed: true } })],
    ["revision", (command: CommandEnvelope) => ({ ...command, expectedRevision: command.expectedRevision + 1 })],
    ["content version", (command: CommandEnvelope) => ({ ...command, contentVersion: "mvp@2" })],
    ["command name", (command: CommandEnvelope) => ({ ...command, commandName: "ServeOrder" })],
  ])("rejects idempotency-key reuse with changed %s", (_label, mutate) => {
    const first = envelope();
    expectFailure("IDEMPOTENCY_PAYLOAD_MISMATCH", () => assertRetryMatches(mutate(first), stored(first)));
  });

  it("rejects a different retry scope before returning stored data", () => {
    const first = envelope();
    const other = { ...first, idempotencyKey: generateIdempotencyKey() };
    expectFailure("INVALID_COMMAND_SHAPE", () => assertRetryMatches(other, stored(first)));
  });

  it("provides stable revision-conflict and disconnected failures", () => {
    expect(revisionConflict(4, 5)).toEqual({
      code: "REVISION_CONFLICT",
      message: "Expected revision 4, but durable state is at revision 5.",
      retryable: true,
      expectedRevision: 4,
      actualRevision: 5,
    });
    expect(disconnectedFailure()).toMatchObject({ code: "DISCONNECTED", retryable: true });
  });
});

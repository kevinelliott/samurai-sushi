import { describe, expect, it } from "vitest";
import { createCommandEnvelope } from "./commands";
import {
  FIRST_EVENING_CONTENT_VERSION,
  FIRST_EVENING_SERVICE_DEFINITION,
  SALMON_SASHIMI_UNLOCK_ID,
  createInitialEveningServiceCheckpoint,
  decodeEveningServiceCheckpoint,
  projectEveningService,
  reduceEveningService,
  type EveningServiceCheckpoint,
} from "./evening-service";
import type { IdempotencyKey, JsonObject } from "./model";

function command(revision: number, commandName: string, payload: JsonObject, suffix: number) {
  return createCommandEnvelope({
    schemaVersion: 1,
    commandName,
    subject: { kind: "guest", guestSessionId: "guest-service-fixture-0001" },
    idempotencyKey: `018f47fe-347b-4dac-8f45-a6f3f43b${suffix.toString().padStart(4, "0")}` as IdempotencyKey,
    expectedRevision: revision,
    contentVersion: FIRST_EVENING_CONTENT_VERSION,
    payload,
  });
}

function apply(checkpoint: EveningServiceCheckpoint, name: string, payload: JsonObject, suffix: number) {
  return reduceEveningService(checkpoint, command(checkpoint.revision, name, payload, suffix));
}

describe("first evening service reducer", () => {
  it("is deeply frozen and keeps wrong choices byte-identical and revision-neutral", () => {
    const initial = createInitialEveningServiceCheckpoint();
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.orders)).toBe(true);
    const started = apply(initial, "service.start", {}, 1);
    const wrong = apply(started.checkpoint, "service.prepare-rice", { beat: "steam" }, 2);
    expect(wrong.response.payload.accepted).toBe(false);
    expect(wrong.checkpoint).toStrictEqual(started.checkpoint);
    expect(wrong.response.payload.correctiveCueId).toBe("cue.rice.expected.wash");
    expect(JSON.stringify(wrong)).not.toMatch(/timestamp|clock|wallet|signature|random|nonce|secret|digest|hmac/i);
  });

  it("rejects loose envelopes, unbounded inputs, and impossible checkpoint shapes", () => {
    const initial = createInitialEveningServiceCheckpoint();
    const valid = command(0, "service.start", {}, 3);
    expect(() => reduceEveningService(initial, { ...valid, browserClock: 1 })).toThrow();
    expect(() => reduceEveningService(initial, { ...valid, payload: { nested: Array.from({ length: 40 }, () => []) } })).toThrow();
    expect(() => decodeEveningServiceCheckpoint({ ...initial, riceBeatIndex: 1 })).toThrow();
    expect(() => decodeEveningServiceCheckpoint({ ...initial, phase: "OPEN", revision: 1,
      orders: [{ ...initial.orders[0], state: "DISCARDED" }, ...initial.orders.slice(1)] })).toThrow();
    expect(() => decodeEveningServiceCheckpoint({ ...initial, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => reduceEveningService({ ...initial, revision: Number.MAX_SAFE_INTEGER }, command(Number.MAX_SAFE_INTEGER, "service.start", {}, 4))).toThrow();
    const corrupted = initial.components.map((component, index) => index === 0 ? { ...component, available: component.available + 1 } : component);
    expect(() => decodeEveningServiceCheckpoint({ ...initial, components: corrupted })).toThrow();
  });

  it("abandons only an open service, discards outstanding work, and never unlocks", () => {
    const idleAttempt = apply(createInitialEveningServiceCheckpoint(), "service.abandon", {}, 5);
    expect(idleAttempt.response.payload.accepted).toBe(false);
    expect(idleAttempt.checkpoint.phase).toBe("IDLE");
    const started = apply(createInitialEveningServiceCheckpoint(), "service.start", {}, 6);
    const abandoned = apply(started.checkpoint, "service.abandon", {}, 7);
    expect(abandoned.checkpoint.phase).toBe("ABANDONED");
    expect(abandoned.checkpoint.orders.map((order) => order.state)).toEqual(["DISCARDED", "DISCARDED", "DISCARDED"]);
    expect(abandoned.checkpoint.unlocks).toEqual([]);
    expect(abandoned.response.payload.settledNow).toBe(false);
  });

  it("exposes explicit projection refs and suppresses replay ceremony", () => {
    const checkpoint = createInitialEveningServiceCheckpoint();
    const manifest = {
      contentVersion: FIRST_EVENING_CONTENT_VERSION,
      serviceDefinition: FIRST_EVENING_SERVICE_DEFINITION,
      contentRefs: ["phase.idle", "prompt.service.start", "service.first-evening"],
    } as const;
    const committed = projectEveningService(checkpoint, manifest, { disposition: "committed", correctiveCueId: null });
    const replayed = projectEveningService(checkpoint, manifest, { disposition: "replayed", correctiveCueId: null });
    expect(committed.currentPromptId).toBe("prompt.service.start");
    expect(committed.announceCeremony).toBe(true);
    expect(replayed.announceCeremony).toBe(false);
    expect(replayed.displayRefs).toEqual(committed.displayRefs);
  });

  it("binds settlement and salmon sashimi as one exact set fact", () => {
    const initial = createInitialEveningServiceCheckpoint();
    const settled = decodeEveningServiceCheckpoint({
      ...initial,
      revision: 29,
      phase: "SETTLED",
      riceBeatIndex: 3,
      presentationChoice: "indigo-rim",
      restorationChoice: "mend-counter-stool",
      activeOrderIndex: 3,
      orders: FIRST_EVENING_SERVICE_DEFINITION.orders.map((order) => ({
        id: order.id,
        state: "SERVED",
        stepIndex: order.steps.length,
        plateFeedbackRef: order.plateFeedbackRef,
        serveFeedbackRef: order.serveFeedbackRef,
      })),
      components: initial.components.map((component) => ({ ...component, available: 0, placed: 0, served: component.total, discarded: 0 })),
      storyFlags: FIRST_EVENING_SERVICE_DEFINITION.orders.map((order) => order.storyFlagId),
      unlocks: [SALMON_SASHIMI_UNLOCK_ID],
    });
    expect(settled.unlocks).toEqual([SALMON_SASHIMI_UNLOCK_ID]);
  });
});

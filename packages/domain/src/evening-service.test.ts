import { describe, expect, it } from "vitest";
import { createCommandEnvelope } from "./commands";
import {
  FIRST_EVENING_CONTENT_VERSION,
  FIRST_EVENING_SERVICE_DEFINITION,
  SALMON_SASHIMI_UNLOCK_ID,
  createInitialEveningServiceCheckpoint,
  decodeEveningServiceCheckpoint,
  projectEveningService,
  rebaseEveningServiceCheckpointForClaim,
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

  it("rebases guest-active service history while preserving the player's monotonic unlock", () => {
    const guest = apply(createInitialEveningServiceCheckpoint(), "service.start", {}, 20).checkpoint;
    const player = decodeEveningServiceCheckpoint({
      ...createInitialEveningServiceCheckpoint(), revision: 29, phase: "SETTLED", riceBeatIndex: 3,
      presentationChoice: "sand-speckle", restorationChoice: "refresh-menu-board", activeOrderIndex: 3,
      orders: FIRST_EVENING_SERVICE_DEFINITION.orders.map((definition) => ({
        id: definition.id, state: "SERVED", stepIndex: definition.steps.length,
        plateFeedbackRef: definition.plateFeedbackRef, serveFeedbackRef: definition.serveFeedbackRef,
      })),
      components: createInitialEveningServiceCheckpoint().components.map((component) => ({
        ...component, available: 0, placed: 0, served: component.total, discarded: 0,
      })),
      storyFlags: FIRST_EVENING_SERVICE_DEFINITION.orders.map((order) => order.storyFlagId),
      unlocks: [SALMON_SASHIMI_UNLOCK_ID],
    });
    const rebased = rebaseEveningServiceCheckpointForClaim(guest, player, 40);
    expect(rebased).toMatchObject({ revision: 40, phase: "OPEN", presentationChoice: null, restorationChoice: null,
      riceBeatIndex: 0, unlocks: [SALMON_SASHIMI_UNLOCK_ID] });
    expect(rebased.orders).toEqual(guest.orders);
    expect(Object.isFrozen(rebased)).toBe(true);
    expect(() => rebaseEveningServiceCheckpointForClaim(guest, player, Number.MAX_SAFE_INTEGER + 1)).toThrow();
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

  it("starts a new run only from abandonment while preserving subject-durable facts", () => {
    const initial = createInitialEveningServiceCheckpoint();
    const started = apply(initial, "service.start", {}, 30);
    const abandoned = apply(started.checkpoint, "service.abandon", {}, 31);
    const durableAbandoned = decodeEveningServiceCheckpoint({
      ...abandoned.checkpoint,
      revision: 47,
      generation: 7,
      storyFlags: [FIRST_EVENING_SERVICE_DEFINITION.orders[0]!.storyFlagId],
      unlocks: [SALMON_SASHIMI_UNLOCK_ID],
    });
    const restarted = apply(durableAbandoned, "service.start-new", {}, 32);
    expect(restarted.response.payload).toMatchObject({ accepted: true, feedbackRef: "feedback.service.new-shift", settledNow: false });
    expect(restarted.checkpoint).toMatchObject({ revision: 48, generation: 8, phase: "OPEN", riceBeatIndex: 0,
      activeOrderIndex: 0, presentationChoice: null, restorationChoice: null,
      storyFlags: durableAbandoned.storyFlags, unlocks: durableAbandoned.unlocks });
    expect(restarted.checkpoint.orders).toEqual(initial.orders);
    expect(restarted.checkpoint.components).toEqual(initial.components);
    expect(Object.isFrozen(restarted.checkpoint)).toBe(true);

    const idleAttempt = apply(initial, "service.start-new", {}, 33);
    expect(idleAttempt.response.payload).toMatchObject({ accepted: false, correctiveCueId: "cue.start-new.invalid" });
    expect(idleAttempt.checkpoint).toStrictEqual(initial);
    expect(() => apply(decodeEveningServiceCheckpoint({ ...abandoned.checkpoint, generation: Number.MAX_SAFE_INTEGER }),
      "service.start-new", {}, 34)).toThrow();
  });

  it("normalizes the exact legacy checkpoint to generation zero and rejects extra legacy fields", () => {
    const current = createInitialEveningServiceCheckpoint();
    const { generation: _generation, ...withoutGeneration } = current;
    const legacy = { ...withoutGeneration, schemaVersion: 1 };
    expect(decodeEveningServiceCheckpoint(legacy)).toMatchObject({ schemaVersion: 2, generation: 0, revision: 0, phase: "IDLE" });
    expect(() => decodeEveningServiceCheckpoint({ ...legacy, generation: 0 })).toThrow();
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

    const opened = apply(checkpoint, "service.start", {}, 35).checkpoint;
    const abandoned = apply(opened, "service.abandon", {}, 36).checkpoint;
    const abandonedManifest = {
      contentVersion: FIRST_EVENING_CONTENT_VERSION,
      serviceDefinition: FIRST_EVENING_SERVICE_DEFINITION,
      contentRefs: ["phase.abandoned", "prompt.service.abandoned", "service.first-evening"],
    } as const;
    const terminal = projectEveningService(abandoned, abandonedManifest, { disposition: "query", correctiveCueId: null });
    expect(terminal).toMatchObject({ currentPromptId: "prompt.service.abandoned", primaryCommand: "service.start-new", announceCeremony: false });
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

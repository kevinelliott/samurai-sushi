import { describe, expect, it } from "vitest";
import {
  FIRST_EVENING_SERVICE_DEFINITION,
  SALMON_SASHIMI_UNLOCK_ID,
  createInitialEveningServiceCheckpoint,
  decodeEveningServiceCheckpoint,
} from "@samurai-sushi/domain/evening-service";
import { deriveSettledServiceCommitment } from "./commitment";

function settledCheckpoint() {
  const initial = createInitialEveningServiceCheckpoint();
  return decodeEveningServiceCheckpoint({
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
    components: initial.components.map((component) => ({
      ...component,
      available: 0,
      placed: 0,
      served: component.total,
      discarded: 0,
    })),
    storyFlags: FIRST_EVENING_SERVICE_DEFINITION.orders.map((order) => order.storyFlagId),
    unlocks: [SALMON_SASHIMI_UNLOCK_ID],
  });
}

describe("settled service commitment", () => {
  it("derives one deterministic opaque public commitment from the exact private settled checkpoint and server nonce", () => {
    const checkpoint = settledCheckpoint();
    const nonce = "ab".repeat(32);
    const commitment = deriveSettledServiceCommitment(checkpoint, nonce);
    expect(commitment).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveSettledServiceCommitment(checkpoint, nonce)).toBe(commitment);
    expect(deriveSettledServiceCommitment(checkpoint, "cd".repeat(32))).not.toBe(commitment);
    expect(commitment).not.toContain(nonce);
    expect(JSON.stringify({ commitment })).not.toMatch(/guest|player|order|dialogue|score|checkpoint|indigo|salmon/i);
  });

  it("rejects non-settled, malformed, and noncanonical server inputs", () => {
    const settled = settledCheckpoint();
    expect(() => deriveSettledServiceCommitment({ ...settled, phase: "CLOSING" }, "ab".repeat(32))).toThrow();
    expect(() => deriveSettledServiceCommitment(settled, "AB".repeat(32))).toThrow(/lowercase/);
    expect(() => deriveSettledServiceCommitment(settled, "ab".repeat(31))).toThrow(/32/);
    expect(() => deriveSettledServiceCommitment({ ...settled, rawGuestId: "guest-private" }, "ab".repeat(32))).toThrow();
  });
});

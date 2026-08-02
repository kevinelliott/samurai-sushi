import {
  FIRST_EVENING_SERVICE_DEFINITION,
  SALMON_SASHIMI_UNLOCK_ID,
  createInitialEveningServiceCheckpoint,
  decodeEveningServiceCheckpoint,
} from "@samurai-sushi/domain/evening-service";

export const FIXTURE_SETTLED_COMMITMENT_NONCE = "ab".repeat(32);

/** Deterministic synthetic SETTLED checkpoint for golden/source-only proofs. */
export function deterministicSettledCheckpointFixture() {
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

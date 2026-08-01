import { describe, expect, it } from "vitest";
import { canonicalizeDecision, persistenceResponseHashDomain } from "./canonical-decision";

const validDecision = () => ({
  checkpointSchemaVersion: 1,
  checkpoint: { step: 1 },
  event: {
    eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd590",
    eventType: "checkpoint.advanced",
    schemaVersion: 1,
    payload: { step: 1 },
  },
  response: { schemaVersion: 1, payload: { accepted: true } },
});

describe("canonical persistence decisions", () => {
  it("pins the domain-separated canonical versioned response hash", () => {
    const canonical = canonicalizeDecision(validDecision());
    expect(persistenceResponseHashDomain).toBe("samurai-sushi:command-response:v1\n");
    expect(canonical.resultHash).toBe("sha256:d195607751165e39b9fa974a30b6590e923c2e0e5cce7ff4fe0442933027895b");
  });

  it.each([
    { ...validDecision(), checkpoint: { step: -0 } },
    { ...validDecision(), response: { schemaVersion: 1, payload: { value: Number.NaN } } },
    { ...validDecision(), extra: true },
    { ...validDecision(), checkpoint: new Date() },
  ])("rejects hostile non-canonical decision values", (decision) => {
    expect(() => canonicalizeDecision(decision)).toThrowError(/canonical|contain|must/i);
  });

  it("rejects accessors without invoking them", () => {
    let reads = 0;
    const decision = validDecision() as Record<string, unknown>;
    Object.defineProperty(decision, "checkpoint", {
      enumerable: true,
      get() {
        reads += 1;
        return { step: reads };
      },
    });
    expect(() => canonicalizeDecision(decision)).toThrowError(/data property/);
    expect(reads).toBe(0);
  });
});

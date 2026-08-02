import { describe, expect, it } from "vitest";
import { DeterministicChainObserver, RECEIPT_FINALITY_POLICY, evaluateReceiptFinalityPolicy, normalizeOperationObservation, reduceOperationObservation, type AttemptObservationState } from "./observation";
import { assertAttemptTransition, assertExpiryTransition, assertIntentTransition } from "./state-machine";

const identity = Object.freeze({ chainId: "NetXtJqPyJGB6Pc", operationHash: `o${"1".repeat(50)}`, sourceAccount: `tz1${"1".repeat(33)}`, contractAddress: `KT1${"1".repeat(33)}`, deploymentManifestHash: "a".repeat(64) });
function observation(disposition: string, overrides: Record<string, unknown> = {}): unknown {
  const inclusion = disposition === "INCLUDED" || disposition === "REORGED";
  return { ...identity, observer: "fake-rpc", sourceObservationId: "fixture:1", sourceSequence: 1, disposition,
    headLevel: inclusion ? 17 : 16, headBlockHash: "Bbcdefghijkmnpqr", includedBlockHash: inclusion ? "Babcdefghijkmnpq" : null,
    includedLevel: inclusion ? 17 : null, operationIndex: inclusion ? 0 : null,
    failureCode: ["FAILED", "DROPPED"].includes(disposition) ? "CHAIN_REJECTED" : null,
    receiptEvent: disposition === "INCLUDED" ? {
      owner: identity.sourceAccount, contractAddress: identity.contractAddress, serviceCommitment: "b".repeat(64),
      contentVersion: "phase-1-evening-service-v1", nonce: "c".repeat(64), payloadHash: "d".repeat(64),
      deploymentManifestHash: identity.deploymentManifestHash,
    } : null, ...overrides };
}
const submitted: AttemptObservationState = Object.freeze({ ...identity, state: "SUBMITTED", lastSourceSequence: null, lastHeadLevel: null, lastHeadBlockHash: null, canonicalBlockHash: null, canonicalBlockLevel: null, confirmations: 0 });

describe("receipt lifecycle observation authority", () => {
  it("normalizes an exact untrusted observation and rejects extra or adapter-finality fields", () => {
    expect(normalizeOperationObservation(observation("INCLUDED"))).toMatchObject({ disposition: "INCLUDED", includedLevel: 17 });
    expect(() => normalizeOperationObservation({ ...(observation("INCLUDED") as object), finalized: true })).toThrow(/field set/);
  });
  it("derives the exact two-confirmation boundary and fails unsupported policies", () => {
    expect(evaluateReceiptFinalityPolicy(RECEIPT_FINALITY_POLICY, { includedLevel: 17, includedBlockHash: "Babcdefghijkmnpq", headLevel: 17, headBlockHash: "Bbcdefghijkmnpqr" })).toMatchObject({ confirmations: 1, confirmed: false, finalized: false });
    expect(evaluateReceiptFinalityPolicy(RECEIPT_FINALITY_POLICY, { includedLevel: 17, includedBlockHash: "Babcdefghijkmnpq", headLevel: 18, headBlockHash: "Bbcdefghijkmnprs" })).toMatchObject({ confirmations: 2, confirmed: true, finalized: true });
    expect(() => evaluateReceiptFinalityPolicy("unknown", { includedLevel: 17, includedBlockHash: "Babcdefghijkmnpq", headLevel: 18, headBlockHash: "Bbcdefghijkmnprs" })).toThrow(/Unsupported/);
  });
  it("emits ordered INCLUDED, CONFIRMED, FINALIZED transitions atomically at equality", () => {
    const decision = reduceOperationObservation(submitted, observation("INCLUDED", { headLevel: 18, headBlockHash: "Bbcdefghijkmnprs" }), RECEIPT_FINALITY_POLICY);
    expect(decision.transitions).toEqual(["INCLUDED", "CONFIRMED", "FINALIZED"]);
    expect(decision.next.state).toBe("FINALIZED");
  });
  it("treats duplicates and lower heads as idempotent or stale", () => {
    const included = reduceOperationObservation(submitted, observation("INCLUDED"), RECEIPT_FINALITY_POLICY);
    expect(reduceOperationObservation(included.next, observation("INCLUDED"), RECEIPT_FINALITY_POLICY).disposition).toBe("DUPLICATE");
    expect(reduceOperationObservation({ ...included.next, lastHeadLevel: 20 }, observation("INCLUDED"), RECEIPT_FINALITY_POLICY).disposition).toBe("STALE");
  });
  it("routes finalized contradiction and rejects identity drift", () => {
    const finalized: AttemptObservationState = { ...submitted, state: "FINALIZED", lastSourceSequence: 3, lastHeadLevel: 18, lastHeadBlockHash: "Bbcdefghijkmnprs" };
    expect(reduceOperationObservation(finalized, observation("REORGED", { sourceSequence: 4, headLevel: 19, headBlockHash: "Bbcdefghijkmnprt" }), RECEIPT_FINALITY_POLICY).disposition).toBe("FINALIZED_CONTRADICTION");
    expect(() => reduceOperationObservation(submitted, observation("INCLUDED", { chainId: "NetXdQprcVkpaWU" }), RECEIPT_FINALITY_POLICY)).toThrow(/identity/);
  });
  it("allows expiry only at the exact database-clock boundary", () => {
    expect(() => assertExpiryTransition("DRAFT", "2026-08-02T12:00:00Z", "2026-08-02T12:00:01Z")).toThrow(/before/);
    expect(() => assertExpiryTransition("DRAFT", "2026-08-02T12:00:01Z", "2026-08-02T12:00:01Z")).not.toThrow();
    expect(() => assertExpiryTransition("REVIEWED", "2026-08-02T12:00:02Z", "2026-08-02T12:00:01Z")).not.toThrow();
  });
  it("fails illegal transitions and provides a deterministic network-free observer", async () => {
    expect(() => assertIntentTransition("DRAFT", "FINALIZED")).toThrow(/cannot transition/);
    expect(() => assertAttemptTransition("DROPPED", "INCLUDED")).toThrow(/cannot transition/);
    const expected = observation("PENDING");
    const observer = new DeterministicChainObserver(new Map([[`${identity.chainId}\0${identity.operationHash}`, expected]]));
    await expect(observer.observe(identity)).resolves.toBe(expected);
  });
});

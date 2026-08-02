import { describe, expect, it } from "vitest";
import { DeterministicChainObserver, RECEIPT_FINALITY_POLICY, evaluateReceiptFinalityPolicy, normalizeOperationObservation, reduceOperationObservation, type AttemptObservationState } from "./observation";
import { assertAttemptTransition, assertExpiryTransition, assertIntentTransition } from "./state-machine";

const identity = Object.freeze({ chainId: "NetXtJqPyJGB6Pc", operationHash: `o${"1".repeat(50)}`, sourceAccount: `tz1${"1".repeat(33)}`, contractAddress: `KT1${"1".repeat(33)}`, deploymentManifestHash: "a".repeat(64) });
function observation(disposition: string, overrides: Record<string, unknown> = {}): unknown {
  const inclusion = disposition === "INCLUDED" || disposition === "REORGED";
  const headLevel = Number(overrides.headLevel ?? (inclusion ? 17 : 16));
  const includedLevel = Number(overrides.includedLevel ?? 17);
  const includedBlockHash = String(overrides.includedBlockHash ?? "Babcdefghijkmnpq");
  const headBlockHash = String(overrides.headBlockHash ?? (headLevel === includedLevel
    ? (disposition === "REORGED" ? "B222222222222222" : includedBlockHash)
    : "Bbcdefghijkmnpqr"));
  const proof = inclusion ? Array.from({ length: headLevel - includedLevel + 1 }, (_, index) => ({
    level: includedLevel + index,
    blockHash: index === 0 ? (disposition === "REORGED" ? "B222222222222222" : includedBlockHash) : (index === headLevel - includedLevel ? headBlockHash : `B33333333333${String(index).padStart(4, "1")}`),
    predecessorHash: index === 0 ? null : (index === 1 ? (disposition === "REORGED" ? "B222222222222222" : includedBlockHash) : `B33333333333${String(index - 1).padStart(4, "1")}`),
  })) : null;
  return { ...identity, observer: "fake-rpc", sourceObservationId: "fixture:1", sourceSequence: 1, disposition,
    headLevel: inclusion ? headLevel : 16, headBlockHash: inclusion ? headBlockHash : "Bbcdefghijkmnpqr", includedBlockHash: inclusion ? includedBlockHash : null,
    includedLevel: inclusion ? includedLevel : null, operationIndex: inclusion ? 0 : null, canonicalChainProof: proof,
    failureCode: ["FAILED", "DROPPED"].includes(disposition) ? "CHAIN_REJECTED" : null,
    receiptEvent: disposition === "INCLUDED" ? {
      owner: identity.sourceAccount, contractAddress: identity.contractAddress, serviceCommitment: "b".repeat(64),
      contentVersion: "phase-1-evening-service-v1", nonce: "c".repeat(64), payloadHash: "d".repeat(64),
      deploymentManifestHash: identity.deploymentManifestHash,
    } : null, ...overrides };
}
const submitted: AttemptObservationState = Object.freeze({ ...identity, state: "SUBMITTED", lastRpcSourceSequence: null, lastIndexerSourceSequence: null, lastHeadLevel: null, lastHeadBlockHash: null, canonicalBlockHash: null, canonicalBlockLevel: null, includedOperationIndex: null, confirmations: 0 });

describe("receipt lifecycle observation authority", () => {
  it("normalizes an exact untrusted observation and rejects extra or adapter-finality fields", () => {
    expect(normalizeOperationObservation(observation("INCLUDED"))).toMatchObject({ disposition: "INCLUDED", includedLevel: 17 });
    expect(() => normalizeOperationObservation({ ...(observation("INCLUDED") as object), finalized: true })).toThrow(/field set/);
  });
  it("derives the exact two-confirmation boundary and fails unsupported policies", () => {
    expect(evaluateReceiptFinalityPolicy(RECEIPT_FINALITY_POLICY, { includedLevel: 17, includedBlockHash: "Babcdefghijkmnpq", headLevel: 17, headBlockHash: "Babcdefghijkmnpq", canonicalChainProof: [{ level: 17, blockHash: "Babcdefghijkmnpq", predecessorHash: null }] })).toMatchObject({ confirmations: 1, confirmed: false, finalized: false });
    const proof = [{ level: 17, blockHash: "Babcdefghijkmnpq", predecessorHash: null }, { level: 18, blockHash: "Bbcdefghijkmnprs", predecessorHash: "Babcdefghijkmnpq" }];
    expect(evaluateReceiptFinalityPolicy(RECEIPT_FINALITY_POLICY, { includedLevel: 17, includedBlockHash: "Babcdefghijkmnpq", headLevel: 18, headBlockHash: "Bbcdefghijkmnprs", canonicalChainProof: proof })).toMatchObject({ confirmations: 2, confirmed: true, finalized: true });
    expect(() => evaluateReceiptFinalityPolicy("unknown", { includedLevel: 17, includedBlockHash: "Babcdefghijkmnpq", headLevel: 18, headBlockHash: "Bbcdefghijkmnprs", canonicalChainProof: proof })).toThrow(/Unsupported/);
    expect(() => evaluateReceiptFinalityPolicy(RECEIPT_FINALITY_POLICY, { includedLevel: 17, includedBlockHash: "Babcdefghijkmnpq", headLevel: 18, headBlockHash: "Bbcdefghijkmnprs", canonicalChainProof: [{ level: 17, blockHash: "Bunrelatedproofx", predecessorHash: null }, proof[1]!] })).toThrow(/ancestry/);
  });
  it("emits ordered INCLUDED, CONFIRMED, FINALIZED transitions atomically at equality", () => {
    const decision = reduceOperationObservation(submitted, observation("INCLUDED", { headLevel: 18, headBlockHash: "Bbcdefghijkmnprs" }), RECEIPT_FINALITY_POLICY);
    expect(decision.transitions).toEqual(["INCLUDED", "CONFIRMED", "FINALIZED"]);
    expect(decision.next.state).toBe("FINALIZED");
  });
  it("rejects equal source sequence changes and treats lower heads as stale", () => {
    const included = reduceOperationObservation(submitted, observation("INCLUDED"), RECEIPT_FINALITY_POLICY);
    expect(() => reduceOperationObservation(included.next, observation("INCLUDED"), RECEIPT_FINALITY_POLICY)).toThrow(/sequence/);
    expect(reduceOperationObservation({ ...included.next, lastHeadLevel: 20 }, observation("INCLUDED", { sourceSequence: 2 }), RECEIPT_FINALITY_POLICY).disposition).toBe("STALE");
  });
  it("routes finalized contradiction and rejects identity drift", () => {
    const finalized: AttemptObservationState = { ...submitted, state: "FINALIZED", lastRpcSourceSequence: 3, lastHeadLevel: 18, lastHeadBlockHash: "Bbcdefghijkmnprs", canonicalBlockLevel: 17, canonicalBlockHash: "Babcdefghijkmnpq", includedOperationIndex: 0, confirmations: 2 };
    expect(reduceOperationObservation(finalized, observation("REORGED", { sourceSequence: 4, headLevel: 19, headBlockHash: "Bbcdefghijkmnprt" }), RECEIPT_FINALITY_POLICY).disposition).toBe("FINALIZED_CONTRADICTION");
    expect(() => reduceOperationObservation(submitted, observation("INCLUDED", { chainId: "NetXdQprcVkpaWU" }), RECEIPT_FINALITY_POLICY)).toThrow(/identity/);
  });
  it("binds every later inclusion to the durable level, block, and operation index", () => {
    const included = reduceOperationObservation(submitted, observation("INCLUDED"), RECEIPT_FINALITY_POLICY).next;
    expect(reduceOperationObservation(included, observation("INCLUDED", { sourceSequence: 2, includedBlockHash: "B222222222222222", headBlockHash: "B222222222222222" }), RECEIPT_FINALITY_POLICY).disposition).toBe("ATTEMPT_CONTRADICTION");
    expect(reduceOperationObservation(included, observation("INCLUDED", { sourceSequence: 2, operationIndex: 1 }), RECEIPT_FINALITY_POLICY).disposition).toBe("ATTEMPT_CONTRADICTION");
    const finalized = reduceOperationObservation(included, observation("INCLUDED", { sourceSequence: 2, headLevel: 18, headBlockHash: "Bbcdefghijkmnprs" }), RECEIPT_FINALITY_POLICY).next;
    expect(finalized).toMatchObject({ state: "FINALIZED", canonicalBlockHash: "Babcdefghijkmnpq", includedOperationIndex: 0, lastHeadLevel: 18, confirmations: 2 });
    expect(reduceOperationObservation(finalized, observation("INCLUDED", { sourceSequence: 3, includedBlockHash: "B222222222222222", headBlockHash: "B222222222222222" }), RECEIPT_FINALITY_POLICY).disposition).toBe("FINALIZED_CONTRADICTION");
    expect(reduceOperationObservation(finalized, observation("INCLUDED", { sourceSequence: 3, operationIndex: 1, headLevel: 18, headBlockHash: "Bbcdefghijkmnprs" }), RECEIPT_FINALITY_POLICY).disposition).toBe("FINALIZED_CONTRADICTION");
  });
  it("requires later proofs to continue the durable head and incidents finalized regression", () => {
    const first = reduceOperationObservation(submitted, observation("INCLUDED"), RECEIPT_FINALITY_POLICY).next;
    const finalized = reduceOperationObservation(first, observation("INCLUDED", { sourceSequence: 2, headLevel: 18, headBlockHash: "Bbcdefghijkmnprs" }), RECEIPT_FINALITY_POLICY).next;
    expect(reduceOperationObservation(finalized, observation("INCLUDED", { sourceSequence: 3, headLevel: 17, headBlockHash: "Babcdefghijkmnpq" }), RECEIPT_FINALITY_POLICY).disposition).toBe("FINALIZED_CONTRADICTION");
    expect(reduceOperationObservation(finalized, observation("INCLUDED", { sourceSequence: 3, headLevel: 19, headBlockHash: "Bbcdefghijkmnprt" }), RECEIPT_FINALITY_POLICY).disposition).toBe("FINALIZED_CONTRADICTION");
    const continued = observation("INCLUDED", { sourceSequence: 3, headLevel: 19, headBlockHash: "Bbcdefghijkmnprt", canonicalChainProof: [
      { level: 17, blockHash: "Babcdefghijkmnpq", predecessorHash: null },
      { level: 18, blockHash: "Bbcdefghijkmnprs", predecessorHash: "Babcdefghijkmnpq" },
      { level: 19, blockHash: "Bbcdefghijkmnprt", predecessorHash: "Bbcdefghijkmnprs" },
    ] });
    expect(reduceOperationObservation(finalized, continued, RECEIPT_FINALITY_POLICY)).toMatchObject({ disposition: "APPLY", transitions: [], next: { state: "FINALIZED", lastHeadLevel: 19, confirmations: 3 } });
  });
  it("records indexer evidence only as a hint and keeps source ordering independent", () => {
    const hint = reduceOperationObservation(submitted, observation("INCLUDED", { observer: "fake-indexer", canonicalChainProof: null, sourceSequence: 999 }), RECEIPT_FINALITY_POLICY);
    expect(hint).toMatchObject({ disposition: "HINT", transitions: [], next: { state: "SUBMITTED", lastIndexerSourceSequence: 999, lastRpcSourceSequence: null } });
    const canonical = reduceOperationObservation(hint.next, observation("INCLUDED", { sourceSequence: 1 }), RECEIPT_FINALITY_POLICY);
    expect(canonical.transitions).toEqual(["INCLUDED"]);
  });
  it("requires exact current-block reorg proof and flags replaced predecessor inclusion", () => {
    const included = reduceOperationObservation(submitted, observation("INCLUDED"), RECEIPT_FINALITY_POLICY).next;
    expect(reduceOperationObservation(included, observation("REORGED", { sourceSequence: 2, includedLevel: 16, includedBlockHash: "B444444444444444", headLevel: 18, headBlockHash: "B555555555555555" }), RECEIPT_FINALITY_POLICY).disposition).toBe("ATTEMPT_CONTRADICTION");
    expect(reduceOperationObservation({ ...submitted, state: "REPLACED" }, observation("INCLUDED"), RECEIPT_FINALITY_POLICY).disposition).toBe("ATTEMPT_CONTRADICTION");
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

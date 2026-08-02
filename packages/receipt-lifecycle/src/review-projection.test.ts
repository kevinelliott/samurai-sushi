import { describe, expect, it } from "vitest";
import {
  GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY,
  RECEIPT_REVIEW_STATE_MEANINGS,
  RECEIPT_STATUS_PRESENTATION,
  parseBrowserSafeReceiptReviewProjection,
} from "./review-projection";
import { assertGeneratedRegisteredReceiptNetworkInventory } from "./network-inventory-generator";

const OPERATION_HASH = `o${"1".repeat(50)}`;

function reviewedProjection(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectionRevision: "1",
    intent: {
      intentRef: `ri_${"A".repeat(22)}`,
      state: "REVIEWED",
      createdAt: "2026-08-02T12:00:00.000Z",
      expiresAt: "2026-08-02T12:15:00.000Z",
    },
    status: { displayState: "REVIEWED", ...RECEIPT_STATUS_PRESENTATION.REVIEWED },
    reviewFacts: {
      domain: "SAMURAI_SUSHI_RECEIPT_V1",
      payloadSchemaVersion: 1,
      network: GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY[0],
      owner: `tz1${"1".repeat(33)}`,
      source: `tz1${"1".repeat(33)}`,
      destination: `KT1${"1".repeat(33)}`,
      entrypoint: "submit_receipt",
      attachedMutez: "0",
      serviceCommitment: "11".repeat(32),
      contentVersion: "phase-1-evening-service-v1",
      nonce: "22".repeat(32),
      issuedAt: "2026-08-02T12:00:00.000Z",
      expiry: "2026-08-02T12:15:00.000Z",
      issuerKeyId: "localnet-issuer-v1",
      issuerPolicyVersion: "localnet-policy-v1",
      packedPayloadHex: "0501",
      payloadHash: "33".repeat(32),
    },
    policy: { confirmationThreshold: "2", finalityPolicyRef: "localnet-two-confirmation-rehearsal-v1" },
    activeAttempt: null,
    canonicalReceipt: null,
    incident: null,
  };
}

function finalizedIncidentProjection(): Record<string, unknown> {
  const value = reviewedProjection();
  value.projectionRevision = "8";
  value.intent = { ...(value.intent as object), state: "FINALIZED" };
  value.status = { displayState: "FINALITY_INCIDENT", ...RECEIPT_STATUS_PRESENTATION.FINALITY_INCIDENT };
  value.activeAttempt = {
    attemptRef: `ra_${"B".repeat(22)}`,
    state: "FINALIZED",
    operationHash: OPERATION_HASH,
    replacesOperationHash: null,
    replacedByOperationHash: null,
    includedLevel: "100",
    includedBlockHash: "Bbcdefghijkmnprt",
    orphanedBlockHash: null,
    confirmations: "2",
    submittedAt: "2026-08-02T12:01:00.000Z",
    includedAt: "2026-08-02T12:02:00.000Z",
    confirmedAt: "2026-08-02T12:03:00.000Z",
    finalizedAt: "2026-08-02T12:03:00.000Z",
    lastObservedAt: "2026-08-02T12:04:00.000Z",
    outcomeRef: null,
  };
  value.canonicalReceipt = {
    operationHash: OPERATION_HASH,
    state: "FINALIZED",
    recordedAt: "2026-08-02T12:02:00.000Z",
    finalizedAt: "2026-08-02T12:03:00.000Z",
  };
  value.incident = {
    kind: "FINALITY_CONTRADICTION",
    messageRef: "receipt.incident.finality-contradiction",
    lastSafeState: "FINALIZED",
    detectedAt: "2026-08-02T12:04:00.000Z",
  };
  return value;
}

describe("browser-safe receipt review projection", () => {
  it("accepts and deeply freezes the exact manifest-derived reviewed projection", () => {
    const parsed = parseBrowserSafeReceiptReviewProjection(reviewedProjection());
    expect(parsed.reviewFacts.network).toBe(GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY[0]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.reviewFacts)).toBe(true);
    expect(Object.isFrozen(parsed.reviewFacts.network)).toBe(true);
  });

  it("rejects private extras, internal IDs, tuple drift, and browser-inferred status", () => {
    const privateExtra = reviewedProjection();
    (privateExtra.reviewFacts as Record<string, unknown>).commitmentNonce = "secret";
    expect(() => parseBrowserSafeReceiptReviewProjection(privateExtra)).toThrow(/unexpected field set/);

    const internalId = reviewedProjection();
    internalId.intent = { ...(internalId.intent as object), intentRef: "00000000-0000-4000-8000-000000000000" };
    expect(() => parseBrowserSafeReceiptReviewProjection(internalId)).toThrow(/intentRef/);

    const tupleDrift = reviewedProjection();
    tupleDrift.reviewFacts = {
      ...(tupleDrift.reviewFacts as object),
      network: { ...GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY[0], networkLabelRef: "network.shadownet" },
    };
    expect(() => parseBrowserSafeReceiptReviewProjection(tupleDrift)).toThrow(/not registered/);

    const inventedSuccess = reviewedProjection();
    inventedSuccess.status = { displayState: "FINALIZED", ...RECEIPT_STATUS_PRESENTATION.FINALIZED };
    expect(() => parseBrowserSafeReceiptReviewProjection(inventedSuccess)).toThrow(/server-authoritative/);
  });

  it("preserves the last safe finalized view during a finality incident", () => {
    const parsed = parseBrowserSafeReceiptReviewProjection(finalizedIncidentProjection());
    expect(parsed.status.displayState).toBe("FINALITY_INCIDENT");
    expect(parsed.intent.state).toBe("FINALIZED");
    expect(parsed.activeAttempt?.state).toBe("FINALIZED");
    expect(parsed.canonicalReceipt?.state).toBe("FINALIZED");
    expect(parsed.incident?.lastSafeState).toBe("FINALIZED");
  });

  it("uses non-absolute finality copy", () => {
    expect(RECEIPT_REVIEW_STATE_MEANINGS.FINALIZED).toBe(
      "The configured finality policy was satisfied and this receipt is treated as finalized. New contradictory chain evidence opens incident review rather than silently downgrading it.",
    );
    expect(Object.values(RECEIPT_REVIEW_STATE_MEANINGS).join(" ")).not.toMatch(/cannot be deleted|permanent|irreversible chain record|can never change/i);
  });

  it("fails generated inventory production, tuple drift, and duplicate mappings closed", () => {
    expect(() => assertGeneratedRegisteredReceiptNetworkInventory([{ profile: "mainnet", chainId: "NetXdQprcVkpaWU", networkLabelRef: "network.mainnet", deploymentManifestHash: "a".repeat(64) }])).toThrow(/unknown or production/);
    expect(() => assertGeneratedRegisteredReceiptNetworkInventory([{ ...GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY[0], chainId: "NetXsqzbfFenSTS" }])).toThrow(/tuple is invalid/);
    expect(() => assertGeneratedRegisteredReceiptNetworkInventory([
      GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY[0], GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY[0],
    ])).toThrow(/duplicate/);
  });
});

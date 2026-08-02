import { describe, expect, it } from "vitest";
import { parseReceiptReviewPreflightResult } from "./preflight";
import { parseReceiptReviewDoorway, parseWalletAccessView, RECEIPT_REVIEW_DOORWAY, WALLET_REVIEW_COPY } from "./presentation";

describe("wallet review browser boundary", () => {
  const access = { schemaVersion: 1, walletLinkRef: "wl_AAAAAAAAAAAAAAAAAAAAAA", state: "ACTIVE_CREDENTIAL_MATCH",
    runtimeGeneration: 1, sessionRevision: 2, providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc",
    account: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6", permissionScopes: ["account"], credentialMatch: true,
    reason: null, presentation: WALLET_REVIEW_COPY["wallet.access.connected"] } as const;

  it("strictly accepts only server-owned account access presentation", () => {
    expect(parseWalletAccessView(access)).toEqual(access);
    expect(() => parseWalletAccessView({ ...access, presentation: { ...access.presentation, message: "provider error" } })).toThrow();
    expect(() => parseWalletAccessView({ ...access, presentation: WALLET_REVIEW_COPY["receipt.preflight.ready"] })).toThrow();
    expect(() => parseWalletAccessView({ ...access, providerId: "provider--name" })).toThrow();
    expect(() => parseWalletAccessView({ ...access, rawProvider: {} })).toThrow();
  });

  it("strictly accepts only the registered server-owned review doorway", () => {
    expect(parseReceiptReviewDoorway(RECEIPT_REVIEW_DOORWAY)).toBe(RECEIPT_REVIEW_DOORWAY);
    expect(() => parseReceiptReviewDoorway({ ...RECEIPT_REVIEW_DOORWAY, actionLabel: "Connect wallet" })).toThrow();
    expect(() => parseReceiptReviewDoorway({ ...RECEIPT_REVIEW_DOORWAY, network: {
      ...RECEIPT_REVIEW_DOORWAY.network, chainId: "NetXsqzbfFenSTS" } })).toThrow();
  });

  it("strictly accepts only the data-only preflight union", () => {
    expect(parseReceiptReviewPreflightResult({ schemaVersion: 1, status: "NOT_READY", reason: "INTENT_EXPIRED" }))
      .toEqual({ schemaVersion: 1, status: "NOT_READY", reason: "INTENT_EXPIRED" });
    expect(parseReceiptReviewPreflightResult({ schemaVersion: 1, status: "REVIEW_READY",
      intentRef: "ri_AAAAAAAAAAAAAAAAAAAAAA", projectionRevision: "1", walletLinkRef: "wl_AAAAAAAAAAAAAAAAAAAAAA",
      runtimeGeneration: 1, sessionRevision: 2, reviewDigest: "a".repeat(64), expiresAt: "2026-08-02T12:15:00.000Z" }))
      .toMatchObject({ status: "REVIEW_READY", projectionRevision: "1" });
    expect(() => parseReceiptReviewPreflightResult({ schemaVersion: 1, status: "REVIEW_READY",
      intentRef: "internal-id", projectionRevision: "01", walletLinkRef: "wl_AAAAAAAAAAAAAAAAAAAAAA",
      runtimeGeneration: -1, sessionRevision: 2, reviewDigest: "a".repeat(64), expiresAt: "2026-08-02T12:15:00Z" })).toThrow();
    expect(() => parseReceiptReviewPreflightResult({ schemaVersion: 1, status: "REVIEW_READY", transport: () => undefined })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { parseWalletLinkChallenge, walletLinkSigningBytes } from "./challenge";

const challenge = Object.freeze({
  domain: "samurai-sushi:receipt-wallet-link:v1", schemaVersion: 1, purpose: "RECEIPT_WALLET_LINK",
  canonicalOrigin: "https://game.samurai-sushi.example", publicLinkRef: "wl_AAAAAAAAAAAAAAAAAAAAAA",
  chainId: "NetXtJqPyJGB6Pc", account: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb",
  providerId: "deterministic-wallet", permissionScopeDigest: "a".repeat(64), runtimeGeneration: 2,
  sessionRevision: 3, privacyPolicyVersion: "receipt-wallet-privacy-v1", nonce: "A".repeat(43),
  issuedAt: "2026-08-02T14:00:00.000Z", expiresAt: "2026-08-02T14:05:00.000Z",
} as const);

describe("wallet-link challenge", () => {
  it("pins every signed coordinate and exact five-minute lifetime", () => {
    expect(parseWalletLinkChallenge(challenge)).toEqual(challenge);
    expect(walletLinkSigningBytes(challenge).subarray(0, 2)).toEqual(Uint8Array.from([5, 1]));
    expect(() => parseWalletLinkChallenge({ ...challenge, purpose: "claim" })).toThrow(/invalid/);
    expect(() => parseWalletLinkChallenge({ ...challenge, expiresAt: "2026-08-02T14:05:00.001Z" })).toThrow(/invalid/);
  });
});

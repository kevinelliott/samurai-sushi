import { describe, expect, it } from "vitest";
import { deriveSettledServiceCommitment } from "./commitment";
import { deterministicSettledCheckpointFixture as settledCheckpoint } from "./test-fixture";

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

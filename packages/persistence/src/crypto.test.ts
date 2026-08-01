import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeDigestEqual,
  GuestSecretFormatError,
  hmacKeyIdentity,
  HmacKeyring,
  issueResumeSecret,
  TombstoneKeyring,
} from "./crypto";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const key = (purpose: "resume" | "tombstone", version: number, marker: number, retired = false) => {
  const bytes = new Uint8Array(32).fill(marker);
  return {
    version,
    key: bytes,
    keyIdentity: hmacKeyIdentity(purpose, bytes),
    activatedAt: new Date("2026-01-01T00:00:00.000Z"),
    retiredAt: retired ? new Date("2026-06-01T00:00:00.000Z") : null,
    verifyUntil: retired ? new Date("2027-01-01T00:00:00.000Z") : null,
    compromisedAt: null,
  } as const;
};

describe("resume-secret digests", () => {
  it("issues canonical 256-bit secrets and verifies current plus previous key versions", () => {
    const secret = issueResumeSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ring = new HmacKeyring(key("resume", 2, 2), key("resume", 1, 1, true));
    const candidates = ring.candidates(secret, NOW);
    expect(candidates.map((candidate) => candidate.keyVersion)).toEqual([2, 1]);
    expect(constantTimeDigestEqual(candidates[0]!.digest, ring.digest(secret, NOW, 2).digest)).toBe(true);
    expect(constantTimeDigestEqual(candidates[0]!.digest, ring.digest(secret, NOW, 1).digest)).toBe(false);
  });

  it("rejects non-canonical or short bearer values before hashing", () => {
    const ring = new HmacKeyring(key("resume", 1, 1));
    expect(() => ring.digest("not-a-secret", NOW)).toThrow(GuestSecretFormatError);
  });

  it("domain-separates irreversible deletion tombstones", () => {
    const ring = new TombstoneKeyring(key("tombstone", 4, 9));
    const replayKey = "018f47fe-347b-7dac-8f45-a6f3f43bd551";
    const guest = ring.digest("guest-session", replayKey, NOW);
    const command = ring.digest("command", replayKey, NOW);
    expect(guest.keyVersion).toBe(4);
    expect(constantTimeDigestEqual(guest.digest, command.digest)).toBe(false);
    expect(Buffer.from(guest.digest).toString("hex")).not.toBe(createHash("sha256").update(replayKey).digest("hex"));
  });

  it("defensively owns key bytes and exposes only immutable primitive lifecycle metadata", () => {
    const configured = key("resume", 7, 7);
    const ring = new HmacKeyring(configured);
    const secret = issueResumeSecret();
    const before = ring.digest(secret, NOW).digest;
    configured.key.fill(99);
    configured.activatedAt.setTime(0);
    expect(ring.active.activatedAtMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(constantTimeDigestEqual(before, ring.digest(secret, NOW).digest)).toBe(true);
    expect(Object.isFrozen(ring.active)).toBe(true);
  });

  it("rejects a same-version key whose bytes do not match its attested identity", () => {
    const configured = key("resume", 8, 8);
    configured.key.fill(9);
    expect(() => new HmacKeyring(configured)).toThrow(/attested key identity/);
  });
});

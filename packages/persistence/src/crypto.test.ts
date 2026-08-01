import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeDigestEqual,
  GuestSecretFormatError,
  HmacKeyring,
  issueResumeSecret,
  TombstoneKeyring,
} from "./crypto";

const key = (version: number, marker: number) => ({ version, key: new Uint8Array(32).fill(marker) });

describe("resume-secret digests", () => {
  it("issues canonical 256-bit secrets and verifies current plus previous key versions", () => {
    const secret = issueResumeSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ring = new HmacKeyring(key(2, 2), key(1, 1));
    const candidates = ring.candidates(secret);
    expect(candidates.map((candidate) => candidate.keyVersion)).toEqual([2, 1]);
    expect(constantTimeDigestEqual(candidates[0]!.digest, ring.digest(secret, 2).digest)).toBe(true);
    expect(constantTimeDigestEqual(candidates[0]!.digest, ring.digest(secret, 1).digest)).toBe(false);
  });

  it("rejects non-canonical or short bearer values before hashing", () => {
    const ring = new HmacKeyring(key(1, 1));
    expect(() => ring.digest("not-a-secret")).toThrow(GuestSecretFormatError);
  });

  it("domain-separates irreversible deletion tombstones", () => {
    const ring = new TombstoneKeyring(key(4, 9));
    const replayKey = "018f47fe-347b-7dac-8f45-a6f3f43bd551";
    const guest = ring.digest("guest-session", replayKey);
    const command = ring.digest("command", replayKey);
    expect(guest.keyVersion).toBe(4);
    expect(constantTimeDigestEqual(guest.digest, command.digest)).toBe(false);
    expect(Buffer.from(guest.digest).toString("hex")).not.toBe(createHash("sha256").update(replayKey).digest("hex"));
  });
});

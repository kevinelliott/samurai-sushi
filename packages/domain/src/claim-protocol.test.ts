import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalClaimChallengeBytes,
  canonicalClaimIntentBytes,
  canonicalClaimSessionRecoveryIntentBytes,
  canonicalPlayerDeletionIntentBytes,
  claimChallengeHashPreimage,
  claimIntentHashPreimage,
  claimSessionRecoveryIntentHashPreimage,
  ClaimProtocolError,
  hashClaimChallenge,
  hashClaimIntent,
  hashClaimSessionRecoveryIntent,
  hashPlayerDeletionIntent,
  parseCanonicalClaimChallengeBytes,
  parseCanonicalClaimIntentBytes,
  parseCanonicalClaimSessionRecoveryIntentBytes,
  parseCanonicalPlayerDeletionIntentBytes,
  parseClaimChallenge,
  parseClaimIntent,
  parseClaimSessionRecoveryIntent,
  parsePlayerDeletionIntent,
  playerDeletionIntentHashPreimage,
  walletSigningBytes,
  walletSigningHex,
} from "./claim-protocol";

interface GoldenFixture {
  readonly intent: Record<string, unknown>;
  readonly intentCanonicalJson: string;
  readonly intentHash: string;
  readonly challenge: Record<string, unknown>;
  readonly challengeCanonicalJson: string;
  readonly challengeHash: string;
  readonly walletSigningHex: string;
}

const fixture = JSON.parse(readFileSync(
  new URL("../fixtures/claim-protocol-v1.json", import.meta.url),
  "utf8",
)) as GoldenFixture;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function expectInvalid(input: unknown, parser: (value: unknown) => unknown): void {
  try {
    parser(input);
    throw new Error("Expected claim protocol validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimProtocolError);
    expect(error).toMatchObject({
      code: "INVALID_CLAIM_PROTOCOL",
      message: "The account-claim protocol payload is invalid.",
    });
    expect(JSON.stringify(error)).not.toContain("attacker-secret");
  }
}

describe("account claim protocol", () => {
  beforeEach(() => vi.stubGlobal("crypto", webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it("pins independent RFC 8785 bytes, domains, and hashes with no self-inclusion", async () => {
    expect(decoder.decode(canonicalClaimIntentBytes(fixture.intent))).toBe(fixture.intentCanonicalJson);
    expect(decoder.decode(claimIntentHashPreimage(fixture.intent))).toBe(
      `samurai-sushi:claim-intent:v1\n${fixture.intentCanonicalJson}`,
    );
    expect(await hashClaimIntent(fixture.intent)).toBe(fixture.intentHash);

    expect(decoder.decode(canonicalClaimChallengeBytes(fixture.challenge))).toBe(fixture.challengeCanonicalJson);
    expect(decoder.decode(claimChallengeHashPreimage(fixture.challenge))).toBe(
      `samurai-sushi:claim-challenge-hash:v1\n${fixture.challengeCanonicalJson}`,
    );
    expect(await hashClaimChallenge(fixture.challenge)).toBe(fixture.challengeHash);
    expect(walletSigningHex(fixture.challenge)).toBe(fixture.walletSigningHex);
    const signingBytes = walletSigningBytes(fixture.challenge);
    expect(signingBytes.subarray(0, 2)).toEqual(Uint8Array.of(0x05, 0x01));
    expect(new DataView(signingBytes.buffer).getUint32(2, false)).toBe(encoder.encode(fixture.challengeCanonicalJson).byteLength);
    expect(signingBytes.subarray(6)).toEqual(encoder.encode(fixture.challengeCanonicalJson));
    expect(() => parseClaimIntent({ ...fixture.intent, claimIntentHash: fixture.intentHash })).toThrow(ClaimProtocolError);
    expect(() => parseClaimChallenge({ ...fixture.challenge, challengeHash: fixture.challengeHash })).toThrow(ClaimProtocolError);
  });

  it("binds lost-response recovery to an exact signed issuance under a separate domain", async () => {
    const recoveryIntent = {
      recoverClaimId: "123e4567-e89b-42d3-a456-426614174000",
      idempotencyKey: "323e4567-e89b-42d3-a456-426614174000",
    };
    const canonical = '{"idempotencyKey":"323e4567-e89b-42d3-a456-426614174000","recoverClaimId":"123e4567-e89b-42d3-a456-426614174000"}';
    expect(decoder.decode(canonicalClaimSessionRecoveryIntentBytes(recoveryIntent))).toBe(canonical);
    expect(decoder.decode(claimSessionRecoveryIntentHashPreimage(recoveryIntent))).toBe(
      `samurai-sushi:claim-session-recovery-intent:v1\n${canonical}`,
    );
    expect(await hashClaimSessionRecoveryIntent(recoveryIntent)).toBe(
      "sha256:6902b7b7348f93637eaefa6099caec0d1551aeba9b6557eafc23b39640f25634",
    );
    expect(await hashClaimSessionRecoveryIntent(recoveryIntent)).not.toBe(await hashClaimIntent(fixture.intent));
    expect(parseCanonicalClaimSessionRecoveryIntentBytes(encoder.encode(canonical))).toEqual(
      parseClaimSessionRecoveryIntent(recoveryIntent),
    );
    for (const hostile of [
      { ...recoveryIntent, recoverClaimId: "223e4567-e89b-42d3-a456-426614174000" },
      { ...recoveryIntent, idempotencyKey: "423e4567-e89b-42d3-a456-426614174000" },
      { ...recoveryIntent, targetPlayerId: "attacker-secret" },
    ]) {
      if ("targetPlayerId" in hostile) expectInvalid(hostile, parseClaimSessionRecoveryIntent);
      else expect(await hashClaimSessionRecoveryIntent(hostile)).not.toBe(await hashClaimSessionRecoveryIntent(recoveryIntent));
    }
  });

  it("binds destructive player deletion under an independent signed operation domain", async () => {
    const deletionIntent = {
      deleteClaimId: "123e4567-e89b-42d3-a456-426614174000",
      idempotencyKey: "323e4567-e89b-42d3-a456-426614174000",
    };
    const canonical = '{"deleteClaimId":"123e4567-e89b-42d3-a456-426614174000","idempotencyKey":"323e4567-e89b-42d3-a456-426614174000"}';
    expect(decoder.decode(canonicalPlayerDeletionIntentBytes(deletionIntent))).toBe(canonical);
    expect(decoder.decode(playerDeletionIntentHashPreimage(deletionIntent))).toBe(
      `samurai-sushi:player-deletion-intent:v1\n${canonical}`,
    );
    expect(await hashPlayerDeletionIntent(deletionIntent)).toBe(
      "sha256:7a6869f9743327134e0cab78f382ad17a3f0bb82dc4c7146161e21594e77506a",
    );
    const recoveryIntent = {
      recoverClaimId: deletionIntent.deleteClaimId,
      idempotencyKey: deletionIntent.idempotencyKey,
    };
    expect(await hashPlayerDeletionIntent(deletionIntent)).not.toBe(
      await hashClaimSessionRecoveryIntent(recoveryIntent),
    );
    expect(parseCanonicalPlayerDeletionIntentBytes(encoder.encode(canonical))).toEqual(
      parsePlayerDeletionIntent(deletionIntent),
    );
    expectInvalid(recoveryIntent, parsePlayerDeletionIntent);
    expectInvalid(deletionIntent, parseClaimSessionRecoveryIntent);
  });

  it("binds every future intent mutation and every challenge context field", async () => {
    const intentMutations = [
      { ...fixture.intent, claimId: "323e4567-e89b-42d3-a456-426614174000" },
      { ...fixture.intent, guestClaimCommitment: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA" },
      { ...fixture.intent, guestRevision: 8 },
      { ...fixture.intent, idempotencyKey: "423e4567-e89b-42d3-a456-426614174000" },
      { ...fixture.intent, contentVersion: "phase0-salmon@2" },
      { ...fixture.intent, cosmeticSelections: { counter: "dawn", norens: "indigo" } },
      {
        ...fixture.intent,
        createPlayer: false,
        targetPlayerId: "player_1234567890abcdef",
        playerRevision: 0,
      },
    ];
    for (const mutation of intentMutations) expect(await hashClaimIntent(mutation)).not.toBe(fixture.intentHash);

    const challengeMutations = [
      { ...fixture.challenge, origin: "https://alternate.samurai-sushi.example" },
      { ...fixture.challenge, chainId: "NetXdQprcVkpaWV" },
      { ...fixture.challenge, account: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjc" },
      { ...fixture.challenge, claimIntentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { ...fixture.challenge, nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      {
        ...fixture.challenge,
        issuedAt: "2026-08-01T20:30:00.001Z",
        expiresAt: "2026-08-01T20:35:00.001Z",
      },
    ];
    for (const mutation of challengeMutations) expect(await hashClaimChallenge(mutation)).not.toBe(fixture.challengeHash);
  });

  it("returns detached, deeply frozen intent branches and preserves caller-independent order", async () => {
    const mutable = structuredClone(fixture.intent);
    mutable.cosmeticSelections = { norens: "indigo", counter: "moonwake" };
    const parsed = parseClaimIntent(mutable);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.cosmeticSelections)).toBe(true);
    expect(decoder.decode(canonicalClaimIntentBytes(mutable))).toBe(fixture.intentCanonicalJson);
    expect(await hashClaimIntent(mutable)).toBe(fixture.intentHash);
    (mutable.cosmeticSelections as Record<string, string>).counter = "attacker-secret";
    expect(parsed.cosmeticSelections.counter).toBe("moonwake");

    const existing = parseClaimIntent({
      ...fixture.intent,
      createPlayer: false,
      targetPlayerId: "player_1234567890abcdef",
      playerRevision: 11,
    });
    expect(existing).toMatchObject({ createPlayer: false, playerRevision: 11 });
  });

  it("rejects every missing and extra intent or challenge field", () => {
    for (const primitive of [null, true, 1, "attacker-secret", []]) {
      expectInvalid(primitive, parseClaimIntent);
      expectInvalid(primitive, parseClaimChallenge);
    }
    for (const key of Object.keys(fixture.intent)) {
      const copy = { ...fixture.intent };
      delete copy[key];
      expectInvalid(copy, parseClaimIntent);
    }
    expectInvalid({ ...fixture.intent, extra: true }, parseClaimIntent);
    for (const key of Object.keys(fixture.challenge)) {
      const copy = { ...fixture.challenge };
      delete copy[key];
      expectInvalid(copy, parseClaimChallenge);
    }
    expectInvalid({ ...fixture.challenge, signature: "attacker-secret" }, parseClaimChallenge);
  });

  it("enforces target/create-player/revision XOR and non-negative safe revisions", () => {
    expectInvalid({ ...fixture.intent, targetPlayerId: "player_1234567890abcdef" }, parseClaimIntent);
    expectInvalid({ ...fixture.intent, playerRevision: 1 }, parseClaimIntent);
    expectInvalid({ ...fixture.intent, createPlayer: false, playerRevision: 1 }, parseClaimIntent);
    expectInvalid({ ...fixture.intent, createPlayer: false, targetPlayerId: "player_1234567890abcdef" }, parseClaimIntent);
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      expectInvalid({ ...fixture.intent, guestRevision: value }, parseClaimIntent);
    }
  });

  it("enforces canonical UUIDv4, commitment, idempotency, and content fields", () => {
    for (const claimId of [
      "123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-42d3-7456-426614174000",
      "123E4567-E89B-42D3-A456-426614174000",
      "attacker-secret",
    ]) expectInvalid({ ...fixture.intent, claimId }, parseClaimIntent);
    for (const guestClaimCommitment of [
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    ]) expectInvalid({ ...fixture.intent, guestClaimCommitment }, parseClaimIntent);
    expectInvalid({ ...fixture.intent, idempotencyKey: "short" }, parseClaimIntent);
    expectInvalid({ ...fixture.intent, idempotencyKey: "A".repeat(25) }, parseClaimIntent);
    expectInvalid({ ...fixture.intent, idempotencyKey: "123e4567-e89b-12d3-a456-426614174000" }, parseClaimIntent);
    expectInvalid({ ...fixture.intent, contentVersion: " leading-space" }, parseClaimIntent);
    expectInvalid({ ...fixture.intent, contentVersion: "x".repeat(129) }, parseClaimIntent);
  });

  it("bounds and validates canonical cosmetic selections", async () => {
    expect(() => parseClaimIntent({ ...fixture.intent, cosmeticSelections: {} })).not.toThrow();
    for (const cosmeticSelections of [
      { "": "option" },
      { "Uppercase": "option" },
      { "dotted.key": "option" },
      { "1-leading-digit": "option" },
      { constructor: "option" },
      { counter: "" },
      { counter: "x".repeat(65) },
      Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`slot${index}`, "option"])),
    ]) expectInvalid({ ...fixture.intent, cosmeticSelections }, parseClaimIntent);
    const changed = { ...fixture.intent, cosmeticSelections: { counter: "dawn", norens: "indigo" } };
    expect(await hashClaimIntent(changed)).not.toBe(fixture.intentHash);
  });

  it("rejects hostile structures before canonicalization and detaches shared data", () => {
    const cycle: Record<string, unknown> = { ...fixture.intent };
    cycle.cosmeticSelections = cycle;
    expectInvalid(cycle, parseClaimIntent);

    const accessor = { ...fixture.intent };
    Object.defineProperty(accessor, "guestRevision", { enumerable: true, get: () => 7 });
    expectInvalid(accessor, parseClaimIntent);

    const symbol = { ...fixture.intent, [Symbol("attacker-secret")]: true };
    expectInvalid(symbol, parseClaimIntent);
    expectInvalid(Object.assign(Object.create({ polluted: true }), fixture.intent), parseClaimIntent);
    expectInvalid({ ...fixture.intent, cosmeticSelections: Array(2) }, parseClaimIntent);
    let getterCalled = false;
    const hostileArray: unknown[] = [];
    Object.defineProperty(hostileArray, "0", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return "attacker-secret";
      },
    });
    hostileArray.length = 1;
    expectInvalid({ ...fixture.intent, cosmeticSelections: hostileArray }, parseClaimIntent);
    expect(getterCalled).toBe(false);
    const extraArray = ["x"];
    Object.defineProperty(extraArray, "extra", { enumerable: true, value: "attacker-secret" });
    expectInvalid({ ...fixture.intent, cosmeticSelections: extraArray }, parseClaimIntent);

    const shared = { counter: "moonwake" };
    const parsed = parseClaimIntent({ ...fixture.intent, cosmeticSelections: shared });
    shared.counter = "attacker-secret";
    expect(parsed.cosmeticSelections.counter).toBe("moonwake");
  });

  it("rejects invalid Unicode, depth, nodes, maps, and UTF-8 size", () => {
    expectInvalid({ ...fixture.intent, contentVersion: "bad\ud800" }, parseClaimIntent);
    let nested: Record<string, unknown> = { value: "x" };
    for (let index = 0; index < 34; index += 1) nested = { child: nested };
    expectInvalid({ ...fixture.intent, extra: nested }, parseClaimIntent);
    expectInvalid({ ...fixture.intent, extra: Array.from({ length: 1_024 }, () => 1) }, parseClaimIntent);
    expectInvalid({ ...fixture.intent, contentVersion: "x".repeat(48 * 1_024 + 1) }, parseClaimIntent);
  });

  it("pins exact five-minute challenge structure and protocol text", () => {
    const parsed = parseClaimChallenge(fixture.challenge);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.account).toBe(fixture.challenge.account);
    expect(parsed.origin).toBe(fixture.challenge.origin);
    expect(() => parseClaimChallenge({ ...fixture.challenge, expiresAt: "2026-08-01T20:34:59.999Z" })).toThrow(ClaimProtocolError);
    expect(() => parseClaimChallenge({ ...fixture.challenge, expiresAt: "2026-08-01T20:35:00.001Z" })).toThrow(ClaimProtocolError);
    for (const issuedAt of ["2026-08-01T20:30:00Z", "2026-08-01 20:30:00.000Z"]) {
      expectInvalid({ ...fixture.challenge, issuedAt }, parseClaimChallenge);
    }
    for (const origin of [
      "http://game.samurai-sushi.example",
      "https://GAME.samurai-sushi.example",
      "https://game.samurai-sushi.example/",
      "https://user@game.samurai-sushi.example",
      "https://game.samurai-sushi.example/path",
    ]) expectInvalid({ ...fixture.challenge, origin }, parseClaimChallenge);
    for (const account of [
      " TZ1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb",
      "TZ1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb",
      "tz1vsur8wwnhlazempoch5d6hlrith8cjcjb",
      "attacker-secret",
      "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton",
      "sr163Lv22CdE8QagCwf48PWDTquk6isQwv57",
    ]) expectInvalid({ ...fixture.challenge, account }, parseClaimChallenge);
    expectInvalid({ ...fixture.challenge, chainId: "netXdQprcVkpaWU" }, parseClaimChallenge);
    for (const account of [
      `tz1${"A".repeat(33)}`,
      `tz2${"A".repeat(33)}`,
      `tz3${"A".repeat(33)}`,
      `tz4${"A".repeat(33)}`,
    ]) expect(() => parseClaimChallenge({ ...fixture.challenge, account })).not.toThrow();
    expectInvalid({ ...fixture.challenge, account: `tz5${"A".repeat(33)}` }, parseClaimChallenge);
    expect(() => parseClaimChallenge({ ...fixture.challenge, origin: "http://localhost:3000" })).not.toThrow();
    expect(() => parseClaimChallenge({ ...fixture.challenge, origin: "http://127.0.0.1:3000" })).not.toThrow();
  });

  it("requires exact canonical UTF-8 bytes on byte decoders", () => {
    expect(parseCanonicalClaimIntentBytes(encoder.encode(fixture.intentCanonicalJson))).toEqual(parseClaimIntent(fixture.intent));
    expect(parseCanonicalClaimChallengeBytes(encoder.encode(fixture.challengeCanonicalJson))).toEqual(parseClaimChallenge(fixture.challenge));
    expect(() => parseCanonicalClaimIntentBytes(encoder.encode(` ${fixture.intentCanonicalJson}`))).toThrow(ClaimProtocolError);
    const duplicateCosmetic = fixture.intentCanonicalJson.replace(
      '"counter":"moonwake"',
      '"counter":"moonwake","counter":"indigo"',
    );
    expect(() => parseCanonicalClaimIntentBytes(encoder.encode(duplicateCosmetic))).toThrow(ClaimProtocolError);
    expect(() => parseCanonicalClaimChallengeBytes(Uint8Array.of(0xff))).toThrow(ClaimProtocolError);
  });
});

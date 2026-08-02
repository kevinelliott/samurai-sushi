import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_CLAIM_REAUTH_REQUIRED, ACCOUNT_PLAYER_DELETE_PUBLIC_FAILURE, CommandAuthenticationError, GuestRotationRequiredError } from "@samurai-sushi/persistence";
import { createInitialEveningServiceCheckpoint } from "@samurai-sushi/domain/evening-service";
import { ACCOUNT_COOKIE_NAMES } from "./cookies";
import { ACCOUNT_ROUTE_PATHS, MAX_JSON_BODY_BYTES, type AccountRouteId } from "./contract";
import type { AccountRuntimeConfig } from "./config";
import { handleAccountHttpRequest, type AccountHttpServices } from "./http";

const guestSecret = Buffer.alloc(32, 21).toString("base64url");
const claimSecret = Buffer.alloc(32, 22).toString("base64url");
const playerSecret = Buffer.alloc(32, 23).toString("base64url");
const replacementSecret = Buffer.alloc(32, 24).toString("base64url");
const origin = "https://game.samurai-sushi.example";
const guard = Buffer.alloc(32, 25).toString("base64url");
const config = { canonicalOrigin: origin, rawHeaderGuard: guard } as AccountRuntimeConfig;

function cookie(...kinds: readonly (keyof typeof ACCOUNT_COOKIE_NAMES)[]): string {
  const values = { guest: guestSecret, claim: claimSecret, player: playerSecret };
  return kinds.map((kind) => `${ACCOUNT_COOKIE_NAMES[kind]}=${values[kind]}`).join("; ");
}

function request(operation: AccountRouteId, body: string, authorityCookies = ""): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "origin": origin,
    "host": "game.samurai-sushi.example",
    "x-samurai-raw-header-guard": guard,
    "x-forwarded-host": "game.samurai-sushi.example",
    "x-forwarded-proto": "https",
    "x-forwarded-port": "443",
  });
  if (authorityCookies) headers.set("cookie", authorityCookies);
  return new Request(`${origin}${ACCOUNT_ROUTE_PATHS.get(operation)}`, { method: "POST", headers, body });
}

function services(overrides: {
  readonly guests?: Readonly<Record<string, unknown>>;
  readonly accounts?: Readonly<Record<string, unknown>>;
  readonly evening?: Readonly<Record<string, unknown>>;
} = {}): AccountHttpServices {
  const guests = {
    issue: vi.fn(async () => ({
      session: { id: "guest-id-0000001", expiresAt: new Date("2026-09-01T00:00:00.000Z") },
      progress: { revision: 0 }, resumeSecret: guestSecret, claimCapability: claimSecret,
    })),
    resume: vi.fn(async () => ({ session: { id: "guest-id-0000001", expiresAt: new Date("2026-09-01T00:00:00.000Z") } })),
    rotate: vi.fn(async () => ({ session: { id: "guest-id-0000001", expiresAt: new Date("2026-09-01T00:00:00.000Z") }, rotatedResumeSecret: replacementSecret })),
    delete: vi.fn(async () => undefined),
    rotateClaimCapability: vi.fn(async () => ({ claimCapability: replacementSecret, expiresAt: new Date("2026-09-01T00:00:00.000Z") })),
    ...overrides.guests,
  };
  const accounts = {
    issueClaimChallenge: vi.fn(async () => ({ challengeId: randomUUID(), challenge: { marker: "challenge" } })),
    claimGuest: vi.fn(async () => ({ playerId: "player-id-000001", claimId: randomUUID(), playerRevision: 0,
      sessionId: randomUUID(), sessionSecret: playerSecret, deliveryGeneration: 1, disposition: "claimed" })),
    issueRecoveryChallenge: vi.fn(async () => ({ challengeId: randomUUID(), challenge: { marker: "challenge" } })),
    recoverClaimSession: vi.fn(async () => ({ playerId: "player-id-000001", claimId: randomUUID(), sessionId: randomUUID(),
      sessionSecret: replacementSecret, deliveryGeneration: 2 })),
    acknowledgeClaimDeliveryExact: vi.fn(async () => undefined),
    authenticatePlayerSession: vi.fn(async () => ({ playerId: "player-id-000001", sessionId: randomUUID(), claimId: randomUUID(),
      deliveryGeneration: 1, credentialKind: "current", rotationRequired: false })),
    rotatePlayerSession: vi.fn(async () => ({ playerId: "player-id-000001", sessionId: randomUUID(), claimId: randomUUID(),
      sessionSecret: replacementSecret, deliveryGeneration: 2, credentialKind: "current", rotationRequired: false })),
    logoutPlayerSession: vi.fn(async () => undefined),
    issuePlayerDeletionChallenge: vi.fn(async () => ({ challengeId: randomUUID(), challenge: { marker: "challenge" } })),
    deletePlayerWithWalletProof: vi.fn(async () => undefined),
    ...overrides.accounts,
  };
  const checkpoint = createInitialEveningServiceCheckpoint();
  const evening = {
    query: vi.fn(async () => ({ checkpoint, revision: 0, contentVersion: checkpoint.contentVersion })),
    execute: vi.fn(async () => ({
      disposition: "committed",
      checkpointAdvanced: false,
      responseSchemaVersion: 1,
      response: { accepted: false, checkpoint, feedbackRef: "cue.start.invalid", correctiveCueId: "cue.start.invalid",
        settledNow: false, unlockedNow: [], outcomeClass: null },
      resultHash: `sha256:${"0".repeat(64)}`,
      committedRevision: 0,
    })),
    ...overrides.evening,
  };
  return { guests, accounts, evening } as unknown as AccountHttpServices;
}

const createIntent = {
  claimId: "2f3fcd86-fd20-47af-ae7b-06f40b7190d8",
  createPlayer: true,
  guestRevision: 0,
  idempotencyKey: "eHh4eHh4eHh4eHh4eHh4eA",
  contentVersion: "phase0-salmon@1",
  cosmeticSelections: {},
};

describe("account HTTP boundary", () => {
  it("sets guest and claim cookies without serializing either secret", async () => {
    const result = await handleAccountHttpRequest("guest.issue", request("guest.issue", JSON.stringify({
      consentVersion: "consent-v1", contentVersion: "phase0-salmon@1", checkpointSchemaVersion: 1, checkpoint: {},
    })), services(), config);
    expect(result.status).toBe(200);
    const body = await result.text();
    expect(body).not.toContain(guestSecret);
    expect(body).not.toContain(claimSecret);
    const setCookie = result.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${ACCOUNT_COOKIE_NAMES.guest}=${guestSecret}; Path=/; Secure; HttpOnly; SameSite=Strict`);
    expect(setCookie).toContain(`${ACCOUNT_COOKIE_NAMES.claim}=${claimSecret}; Path=/; Secure; HttpOnly; SameSite=Strict`);
  });

  it("derives the browser first-service checkpoint server-side and publishes no gameplay authority", async () => {
    const issue = vi.fn(services().guests.issue.bind(services().guests));
    const result = await handleAccountHttpRequest("guest.issue", request("guest.issue", JSON.stringify({
      consentVersion: "first-service-browser-v1",
    })), services({ guests: { issue } }), config);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ issued: true });
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({
      consentVersion: "first-service-browser-v1",
      contentVersion: "phase-1-evening-service-v1",
      checkpointSchemaVersion: 2,
      checkpoint: expect.objectContaining({ phase: "IDLE", revision: 0, generation: 0 }),
    }));

    const rejected = await handleAccountHttpRequest("guest.issue", request("guest.issue", JSON.stringify({
      consentVersion: "unreviewed-browser-contract",
    })), services(), config);
    expect(rejected.status).toBe(400);
  });

  it("injects the HttpOnly capability and rejects a client-supplied commitment", async () => {
    const issue = vi.fn(async () => ({ challengeId: randomUUID(), challenge: {} }));
    const runtime = services({ accounts: { issueClaimChallenge: issue } });
    const accepted = await handleAccountHttpRequest("claim.challenge", request("claim.challenge", JSON.stringify({
      intent: createIntent, account: "tz1fake",
    }), cookie("guest", "claim")), runtime, config);
    expect(accepted.status).toBe(200);
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ intent: { ...createIntent, guestClaimCommitment: claimSecret } }));
    const rejected = await handleAccountHttpRequest("claim.challenge", request("claim.challenge", JSON.stringify({
      intent: { ...createIntent, guestClaimCommitment: claimSecret }, account: "tz1fake",
    }), cookie("guest", "claim")), runtime, config);
    expect(rejected.status).toBe(400);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("applies successful claim and recovery cookie transitions only after repository success", async () => {
    const claim = await handleAccountHttpRequest("claim.submit", request("claim.submit", JSON.stringify({
      intent: createIntent, challengeId: randomUUID(), proof: { challenge: {}, publicKey: "hostile-key", signature: "hostile-signature" },
    }), cookie("guest", "claim")), services(), config);
    const claimCookies = claim.headers.get("set-cookie") ?? "";
    expect(claimCookies).toContain(`${ACCOUNT_COOKIE_NAMES.guest}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    expect(claimCookies).toContain(`${ACCOUNT_COOKIE_NAMES.claim}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    expect(claimCookies).toContain(`${ACCOUNT_COOKIE_NAMES.player}=${playerSecret}; Path=/; Secure; HttpOnly; SameSite=Strict`);
    expect(await claim.text()).not.toContain(playerSecret);

    const recovery = await handleAccountHttpRequest("recovery.submit", request("recovery.submit", JSON.stringify({
      recoveryIntent: {}, challengeId: randomUUID(), proof: { challenge: {}, publicKey: "hostile-key", signature: "hostile-signature" },
    }), cookie("guest")), services(), config);
    const recoveryCookies = recovery.headers.get("set-cookie") ?? "";
    expect(recoveryCookies).toContain(`${ACCOUNT_COOKIE_NAMES.player}=${replacementSecret}`);
    expect(recoveryCookies).toContain(`${ACCOUNT_COOKIE_NAMES.guest}=;`);
    expect(await recovery.text()).not.toContain(replacementSecret);
  });

  it("preserves REAUTH_REQUIRED without coordinates or cookie effects", async () => {
    const runtime = services({ accounts: { claimGuest: vi.fn(async () => ACCOUNT_CLAIM_REAUTH_REQUIRED) } });
    const result = await handleAccountHttpRequest("claim.submit", request("claim.submit", JSON.stringify({
      intent: createIntent, challengeId: randomUUID(), proof: { challenge: {}, publicKey: "key", signature: "signature" },
    }), cookie("guest", "claim")), runtime, config);
    expect(result.status).toBe(401);
    expect(result.headers.has("set-cookie")).toBe(false);
    expect(await result.json()).toEqual(ACCOUNT_CLAIM_REAUTH_REQUIRED);
  });

  it("never publishes an unknown future repository code or message", async () => {
    const runtime = services({ accounts: { authenticatePlayerSession: vi.fn(async () => ({
      code: "INTERNAL_WALLET_KEY_MISSING", message: "hostile-internal-marker",
    })) } });
    const result = await handleAccountHttpRequest("player.authenticate",
      request("player.authenticate", "{}", cookie("player")), runtime, config);
    expect(result.status).toBe(400);
    expect(await result.text()).toBe('{"code":"REQUEST_REJECTED","message":"The request could not be processed."}');
  });

  it("rejects cookie confusion, duplicate JSON keys, wrong origin, and oversized bodies before services", async () => {
    const runtime = services();
    const confused = await handleAccountHttpRequest("guest.resume", request("guest.resume", "{}", cookie("guest", "player")), runtime, config);
    expect(confused.status).toBe(400);
    const duplicate = await handleAccountHttpRequest("guest.resume", request("guest.resume", '{"a":1,"a":2}', cookie("guest")), runtime, config);
    expect(duplicate.status).toBe(400);
    const cross = request("guest.resume", "{}", cookie("guest"));
    cross.headers.set("origin", "https://attacker.example");
    expect((await handleAccountHttpRequest("guest.resume", cross, runtime, config)).status).toBe(400);
    const huge = `{"x":"${"a".repeat(MAX_JSON_BODY_BYTES)}"}`;
    expect((await handleAccountHttpRequest("guest.resume", request("guest.resume", huge, cookie("guest")), runtime, config)).status).toBe(413);
  });

  it("keeps logging no-throw, frozen, and structurally blind to hostile request markers", async () => {
    const events: string[] = [];
    const logger = vi.fn((event: unknown) => {
      events.push(JSON.stringify(event));
      expect(Object.isFrozen(event)).toBe(true);
      throw new Error("logger unavailable");
    });
    const result = await handleAccountHttpRequest("claim.submit", request("claim.submit", JSON.stringify({
      intent: createIntent, challengeId: randomUUID(), proof: { challenge: { nonce: "HOSTILE_NONCE" },
        publicKey: "HOSTILE_PUBLIC_KEY", signature: "HOSTILE_SIGNATURE" },
    }), cookie("guest", "claim")), services(), config, logger);
    expect(result.status).toBe(200);
    expect(events.join(" ")).not.toMatch(/HOSTILE|tz|signature|nonce|cookie|claimSecret/i);
  });

  it("allows guest-only capability recovery and deletion while forbidding player confusion", async () => {
    const runtime = services();
    expect((await handleAccountHttpRequest("guest.claim-capability.rotate",
      request("guest.claim-capability.rotate", "{}", cookie("guest")), runtime, config)).status).toBe(200);
    expect((await handleAccountHttpRequest("guest.delete",
      request("guest.delete", "{}", cookie("guest")), runtime, config)).status).toBe(200);
    expect((await handleAccountHttpRequest("guest.resume",
      request("guest.resume", "{}", cookie("guest", "player")), runtime, config)).status).toBe(400);
  });

  it.each(["guest.issue", "guest.resume", "guest.rotate", "guest.delete", "guest.claim-capability.rotate"] as const)(
    "maps malformed %s cookies to a transport rejection before repository work",
    async (operation) => {
      const runtime = services();
      const malformed = [
        `${ACCOUNT_COOKIE_NAMES.guest}=${guestSecret}; ${ACCOUNT_COOKIE_NAMES.guest}=${guestSecret}`,
        `${ACCOUNT_COOKIE_NAMES.guest}=${guestSecret.slice(0, -1)}B`,
        `${ACCOUNT_COOKIE_NAMES.guest}="${guestSecret}"`,
        `${ACCOUNT_COOKIE_NAMES.guest}=${guestSecret}%00`,
        `${ACCOUNT_COOKIE_NAMES.guest}=${guestSecret}\u0001`,
        `${ACCOUNT_COOKIE_NAMES.guest}=${guestSecret}; ${Array.from({ length: 32 }, (_, index) => `x${index}=v`).join("; ")}`,
        `x=${"a".repeat(4_097)}`,
      ];
      for (const header of malformed) {
        const result = await handleAccountHttpRequest(operation, request(operation, "{}", header), runtime, config);
        expect(result.status).toBe(400);
        expect(await result.json()).toEqual({ code: "REQUEST_REJECTED", message: "The request could not be processed." });
      }
      for (const method of Object.values(runtime.guests) as unknown as { mock?: { calls: unknown[] } }[]) {
        if (method.mock) expect(method.mock.calls).toHaveLength(0);
      }
    },
  );

  it("clears a stale player cookie only for an exact completed wallet deletion replay", async () => {
    const body = JSON.stringify({ deletionIntent: {}, challengeId: randomUUID(),
      proof: { challenge: {}, publicKey: "key", signature: "signature" } });
    const completed = services({ accounts: { deletePlayerWithWalletProof: vi.fn(async () => ({ disposition: "already-deleted" })) } });
    const replay = await handleAccountHttpRequest("deletion.submit",
      request("deletion.submit", body, cookie("player")), completed, config);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("set-cookie")).toContain(`${ACCOUNT_COOKIE_NAMES.player}=;`);

    const failed = services({ accounts: { deletePlayerWithWalletProof: vi.fn(async () => ACCOUNT_PLAYER_DELETE_PUBLIC_FAILURE) } });
    const rejected = await handleAccountHttpRequest("deletion.submit",
      request("deletion.submit", body, cookie("player")), failed, config);
    expect(rejected.status).toBe(409);
    expect(rejected.headers.has("set-cookie")).toBe(false);
  });

  it("derives the service subject only from the admitted cookie and returns pinned projections", async () => {
    const execute = vi.fn(services().evening!.execute.bind(services().evening));
    const runtime = services({ evening: { execute } });
    const body = JSON.stringify({ idempotencyKey: randomUUID(), expectedRevision: 0,
      commandName: "service.start", payload: {} });
    const guest = await handleAccountHttpRequest("service.command",
      request("service.command", body, cookie("guest", "claim")), runtime, config);
    expect(guest.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ kind: "guest", resumeSecret: guestSecret }, expect.objectContaining({ commandName: "service.start" }));
    const published = await guest.text();
    expect(published).toContain('"prompt":{"ref":"prompt.service.start"');
    expect(published).toContain('"disposition":"committed"');
    expect(published).not.toMatch(new RegExp(`${guestSecret}|${claimSecret}|guestId|playerId|subjectKind|resultHash|checkpoint|contentManifestHash|artAssetMapHash`));

    const playerRuntime = services();
    const player = await handleAccountHttpRequest("service.query",
      request("service.query", "{}", cookie("player")), playerRuntime, config);
    expect(player.status).toBe(200);
    expect(playerRuntime.evening!.query).toHaveBeenCalledWith({ kind: "player", sessionSecret: playerSecret });
  });

  it("maps an invalid credential to one privacy-safe service authentication response", async () => {
    const error = new CommandAuthenticationError();
    const runtime = services({ evening: { query: vi.fn(async () => { throw error; }) } });
    const result = await handleAccountHttpRequest("service.query", request("service.query", "{}", cookie("guest")), runtime, config);
    expect(result.status).toBe(401);
    expect(result.headers.has("set-cookie")).toBe(false);
    expect(await result.json()).toEqual({ code: "SERVICE_AUTHORITY_REJECTED", message: "Service access could not be authenticated." });
  });

  it("refreshes a rotation-due guest without replacing its subject authority", async () => {
    const runtime = services({
      evening: { query: vi.fn(async () => { throw new GuestRotationRequiredError(); }) },
      guests: { resume: vi.fn(async () => ({ session: { id: "guest-id-0000001", expiresAt: new Date("2026-09-01T00:00:00.000Z") }, credentialKind: "current", rotatedResumeSecret: replacementSecret })) },
    });
    const result = await handleAccountHttpRequest("service.query", request("service.query", "{}", cookie("guest", "claim")), runtime, config);
    expect(result.status).toBe(428);
    expect(result.headers.get("set-cookie")).toContain("__Host-samurai-guest=");
    expect(runtime.guests.resume).toHaveBeenCalledWith(guestSecret);
    expect(runtime.guests.issue).not.toHaveBeenCalled();
    expect(await result.json()).toEqual({ code: "SERVICE_CREDENTIAL_REFRESHED", message: "Service access was refreshed. Requery the saved service." });
  });

  it("keeps service body errors and repository conflicts distinct from authentication", async () => {
    const malformed = await handleAccountHttpRequest("service.command", request("service.command", "{}", cookie("guest")), services(), config);
    expect(malformed.status).toBe(400);
    const conflict = await handleAccountHttpRequest("service.query", request("service.query", "{}", cookie("guest")),
      services({ evening: { query: vi.fn(async () => { throw new Error("hostile-conflict-marker"); }) } }), config);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "SERVICE_REQUEST_REJECTED", message: "The saved service could not be updated." });
  });

  it.each(["subjectKind", "guestId", "playerId", "account", "publicKey", "signature", "claimId", "chainId", "origin", "clock", "rngSeed", "keyVersion"])(
    "rejects forbidden gameplay authority field %s before repository work",
    async (field) => {
      const runtime = services();
      const result = await handleAccountHttpRequest("service.command", request("service.command", JSON.stringify({
        idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {}, [field]: "hostile",
      }), cookie("guest", "claim")), runtime, config);
      expect(result.status).toBe(400);
      expect(runtime.evening!.execute).not.toHaveBeenCalled();
    },
  );

  it("pins the complete cookie-authority inventory for every operation", async () => {
    const id = randomUUID();
    const bodies: Readonly<Record<AccountRouteId, string>> = {
      "cookies.reset": "{}",
      "guest.issue": JSON.stringify({ consentVersion: "v1", contentVersion: "v1", checkpointSchemaVersion: 1, checkpoint: {} }),
      "guest.resume": "{}", "guest.rotate": "{}", "guest.delete": "{}", "guest.claim-capability.rotate": "{}",
      "claim.challenge": JSON.stringify({ intent: createIntent, account: "tz1fake" }),
      "claim.submit": JSON.stringify({ intent: createIntent, challengeId: id,
        proof: { challenge: {}, publicKey: "key", signature: "signature" } }),
      "recovery.challenge": JSON.stringify({ recoveryIntent: {}, account: "tz1fake" }),
      "recovery.submit": JSON.stringify({ recoveryIntent: {}, challengeId: id,
        proof: { challenge: {}, publicKey: "key", signature: "signature" } }),
      "claim.delivery": JSON.stringify({ playerId: "player-id-000001", claimId: id, sessionId: id, deliveryGeneration: 1 }),
      "player.authenticate": "{}", "player.rotate": "{}", "player.logout": "{}",
      "deletion.challenge": JSON.stringify({ deletionIntent: {}, account: "tz1fake" }),
      "deletion.submit": JSON.stringify({ deletionIntent: {}, challengeId: id,
        proof: { challenge: {}, publicKey: "key", signature: "signature" } }),
      "service.query": "{}",
      "service.command": JSON.stringify({ idempotencyKey: id, expectedRevision: 0, commandName: "service.start", payload: {} }),
    };
    const allowed: Readonly<Record<AccountRouteId, readonly string[]>> = {
      "cookies.reset": ["", "guest", "claim", "player", "claim,guest", "guest,player", "claim,player", "claim,guest,player"],
      "guest.issue": [""],
      "guest.resume": ["guest", "claim,guest"], "guest.rotate": ["guest", "claim,guest"],
      "guest.delete": ["guest", "claim,guest"], "guest.claim-capability.rotate": ["guest", "claim,guest"],
      "claim.challenge": ["claim,guest"], "claim.submit": ["claim,guest"],
      "recovery.challenge": ["", "claim", "guest", "claim,guest"],
      "recovery.submit": ["", "claim", "guest", "claim,guest"],
      "claim.delivery": ["player"], "player.authenticate": ["player"], "player.rotate": ["player"], "player.logout": ["player"],
      "deletion.challenge": ["", "player"], "deletion.submit": ["", "player"],
      "service.query": ["guest", "claim,guest", "player"],
      "service.command": ["guest", "claim,guest", "player"],
    };
    const combinations = [[], ["guest"], ["claim"], ["player"], ["guest", "claim"],
      ["guest", "player"], ["claim", "player"], ["guest", "claim", "player"]] as const;
    for (const operation of Object.keys(bodies) as AccountRouteId[]) {
      for (const kinds of combinations) {
        const key = [...kinds].sort().join(",");
        const result = await handleAccountHttpRequest(operation,
          request(operation, bodies[operation], cookie(...kinds)), services(), config);
        const expected = allowed[operation].includes(key) ? 200
          : operation === "service.query" || operation === "service.command" ? 401 : 400;
        expect(result.status, `${operation} with ${key || "no authority"}`).toBe(expected);
        if (expected === 401 && operation.startsWith("service.")) {
          expect(await result.json()).toEqual({ code: "SERVICE_AUTHORITY_REJECTED", message: "Service access could not be authenticated." });
        }
      }
    }
  });
});

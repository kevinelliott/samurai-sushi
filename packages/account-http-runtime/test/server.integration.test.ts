import { readdir, readFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect as connectSocket } from "node:net";
import { resolve } from "node:path";
import { createHash, generateKeyPairSync, randomUUID, sign as signMessage } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { b58Encode, getPkhfromPk, PrefixV2 } from "@taquito/utils";
import { compiledFirstEveningService } from "@samurai-sushi/content";
import { canonicalJson } from "@samurai-sushi/domain";
import { walletSigningBytes } from "@samurai-sushi/domain/claim-protocol";
import { Pool, type PoolClient, type QueryResult as PgQueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNT_CLAIM_REAUTH_REQUIRED, applyMigrations, HmacKeyring, hmacKeyIdentity, keyIdentityBytes, PlayerSessionKeyring,
  type ConnectedSqlClient, type QueryResult, type SqlPool, type SqlValue } from "@samurai-sushi/persistence";
import { startAccountNextServer, type AccountNextServer } from "../src/server";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; production HTTP tests must never skip silently.");

class PgClientAdapter implements ConnectedSqlClient {
  constructor(private readonly client: PoolClient) {}
  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    const result: PgQueryResult<Row> = await this.client.query(text, values ? [...values] : undefined);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  release(): void { this.client.release(); }
}

class PgPoolAdapter implements SqlPool {
  constructor(private readonly pool: Pool) {}
  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    const result: PgQueryResult<Row> = await this.pool.query(text, values ? [...values] : undefined);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  async connect(): Promise<ConnectedSqlClient> { return new PgClientAdapter(await this.pool.connect()); }
}

const appRoot = resolve(import.meta.dirname, "../../../apps/web");
const canonicalOrigin = "https://game.samurai-sushi.example";
const canonicalHost = "game.samurai-sushi.example";
const issueBody = JSON.stringify({ consentVersion: "v1", contentVersion: "v1", checkpointSchemaVersion: 1, checkpoint: {} });

function environment(guardByte: number, applicationName: string): NodeJS.ProcessEnv {
  const key = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");
  const separator = databaseUrl!.includes("?") ? "&" : "?";
  return {
    TEZOS_CHAIN_ID: "NetXtJqPyJGB6Pc",
    SAMURAI_CANONICAL_ORIGIN: canonicalOrigin,
    SAMURAI_DATABASE_URL: `${databaseUrl}${separator}application_name=${applicationName}`,
    SAMURAI_HMAC_ACTIVATED_AT: "2026-08-01T00:00:00.000Z",
    SAMURAI_HMAC_RESUME_KEY: key(9),
    SAMURAI_HMAC_TOMBSTONE_KEY: key(10),
    SAMURAI_HMAC_GUEST_CLAIM_KEY: key(11),
    SAMURAI_HMAC_PLAYER_SESSION_KEY: key(12),
    SAMURAI_INTERNAL_RAW_HEADER_GUARD: key(guardByte),
    SAMURAI_RECEIPT_DESTINATION: "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton",
    SAMURAI_RECEIPT_ISSUER_SECRET_KEY_HEX: "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  };
}

function portOf(server: AccountNextServer): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  return address.port;
}

async function requestIssue(port: number): Promise<{ readonly status: number; readonly rawHeaders: readonly string[]; readonly body: string }> {
  return requestJson(port, "/api/account/guest/issue", issueBody);
}

async function requestJson(
  port: number,
  path: string,
  body: string,
  cookie?: string,
): Promise<{ readonly status: number; readonly rawHeaders: readonly string[]; readonly body: string }> {
  return new Promise((resolveRequest, reject) => {
    const headers: Record<string, string | number> = {
      Host: canonicalHost, Origin: canonicalOrigin, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
    };
    if (cookie) headers.Cookie = cookie;
    const request = httpRequest({
      host: "127.0.0.1", port, path, method: "POST", headers,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, rawHeaders: response.rawHeaders, body }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function requestAndDropAfterCommit(
  port: number,
  path: string,
  body: string,
  cookie: string,
): Promise<void> {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest({
      host: "127.0.0.1", port, path, method: "POST", headers: {
        Host: canonicalHost, Origin: canonicalOrigin, Cookie: cookie,
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      response.once("data", () => {
        response.destroy();
        resolveRequest();
      });
      response.once("error", () => resolveRequest());
    });
    request.once("error", reject);
    request.end(body);
  });
}

function setCookies(rawHeaders: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "set-cookie") result.push(rawHeaders[index + 1]!);
  }
  return result;
}

function cookieValue(headers: readonly string[], name: string): string {
  const prefix = `${name}=`;
  const item = setCookies(headers).find((value) => value.startsWith(prefix) && !value.includes("Max-Age=0"));
  if (!item) throw new Error(`Missing ${name} cookie.`);
  return item.slice(prefix.length).split(";", 1)[0]!;
}

function cookiePair(guest: string, claim: string): string {
  return `__Host-samurai-guest=${guest}; __Host-samurai-guest-claim=${claim}`;
}

function testWallet(): {
  readonly account: string;
  readonly publicKey: string;
  readonly sign: (challenge: unknown) => string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyText = b58Encode(publicDer.subarray(publicDer.byteLength - 32), PrefixV2.Ed25519PublicKey);
  return {
    account: getPkhfromPk(publicKeyText),
    publicKey: publicKeyText,
    sign: (challenge) => b58Encode(
      signMessage(null, blake2b(walletSigningBytes(challenge), { dkLen: 32 }), privateKey),
      PrefixV2.Ed25519Signature,
    ),
  };
}

function challengeBody(result: { readonly body: string }): { readonly challengeId: string; readonly challenge: unknown } {
  const parsed = JSON.parse(result.body) as { readonly challengeId?: unknown; readonly challenge?: unknown };
  if (typeof parsed.challengeId !== "string" || !parsed.challenge) throw new Error("Missing signed challenge coordinates.");
  return { challengeId: parsed.challengeId, challenge: parsed.challenge };
}

async function rawRequest(port: number, bytes: string): Promise<string> {
  return new Promise((resolveRequest, reject) => {
    const socket = connectSocket({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(bytes));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolveRequest(response));
    socket.on("error", reject);
  });
}

function rawIssue(headers: readonly string[] = [], target = "/api/account/guest/issue"): string {
  return [
    `POST ${target} HTTP/1.1`,
    `Host: ${canonicalHost}`,
    `Origin: ${canonicalOrigin}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(issueBody)}`,
    "Connection: close",
    ...headers,
    "",
    issueBody,
  ].join("\r\n");
}

describe("built account HTTP boundary", () => {
  const admin = new Pool({ connectionString: databaseUrl });
  let server: AccountNextServer;

  async function guestIdFor(secret: string, keyByte = 9, version = 1): Promise<string> {
    const bytes = Buffer.alloc(32, keyByte);
    const keys = new HmacKeyring({
      version, key: bytes, keyIdentity: hmacKeyIdentity("resume", bytes),
      activatedAt: new Date("2026-08-01T00:00:00.000Z"), retiredAt: null, verifyUntil: null, compromisedAt: null,
    });
    const digest = keys.digest(secret, new Date("2026-08-02T00:00:00.000Z"));
    const row = (await admin.query<{ readonly guest_session_id: string }>(
      `SELECT guest_session_id FROM samurai_persistence.guest_resume_digests
        WHERE digest_key_version=$1 AND digest_key_identity=$2 AND digest=$3`,
      [digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest],
    )).rows[0];
    if (!row) throw new Error("Expected exact guest digest fixture.");
    return row.guest_session_id;
  }

  beforeAll(async () => {
    await admin.query("DROP SCHEMA IF EXISTS samurai_persistence CASCADE");
    await applyMigrations(new PgPoolAdapter(admin));
    server = await startAccountNextServer({ appRoot, port: 0, hostname: "127.0.0.1", dev: false,
      environment: environment(13, "samurai_http_first") });
  });

  afterAll(async () => {
    if (server) await server.closeAll();
    await admin.end();
  });

  it("crosses the real Next adapter with canonical HTTPS authority and separate exact cookies", async () => {
    const result = await requestIssue(portOf(server));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ revision: 0 });
    const cookies = setCookies(result.rawHeaders);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^__Host-samurai-guest=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    expect(cookies[1]).toMatch(/^__Host-samurai-guest-claim=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  });

  it.each([
    ["caller guard", ["X-Samurai-Raw-Header-Guard: hostile"], "/api/account/guest/issue"],
    ["forwarded host", ["X-Forwarded-Host: hostile.example"], "/api/account/guest/issue"],
    ["duplicate content type", ["Content-Type: application/json"], "/api/account/guest/issue"],
    ["duplicate origin", [`Origin: ${canonicalOrigin}`], "/api/account/guest/issue"],
    ["encoded account", [], "/api/%61ccount/guest/issue"],
    ["encoded slash", [], "/api/account%2fguest/issue"],
    ["dot segment", [], "/api/account/../account/guest/issue"],
    ["repeated slash", [], "/api/account//guest/issue"],
    ["trailing slash", [], "/api/account/guest/issue/"],
    ["unknown route", [], "/api/account/guest/unknown"],
  ])("rejects %s at the raw socket boundary", async (_label, headers, target) => {
    const result = await rawRequest(portOf(server), rawIssue(headers, target));
    expect(result).toMatch(/^HTTP\/1\.1 400 /);
    expect(result.toLowerCase()).toContain("cache-control: no-store");
  });

  it("rejects an oversized chunked body before parsing", async () => {
    const body = "x".repeat(32_769);
    const request = [
      "POST /api/account/guest/issue HTTP/1.1",
      `Host: ${canonicalHost}`,
      `Origin: ${canonicalOrigin}`,
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "Connection: close",
      "",
      body.length.toString(16), body, "0", "", "",
    ].join("\r\n");
    expect(await rawRequest(portOf(server), request)).toMatch(/^HTTP\/1\.1 413 /);
  });

  it("closes the singleton pool and permits a new immutable server configuration", async () => {
    await server.closeAll();
    const firstConnections = await admin.query<{ count: string }>(
      "SELECT count(*)::text FROM pg_stat_activity WHERE application_name = 'samurai_http_first'",
    );
    expect(firstConnections.rows[0]?.count).toBe("0");
    const blocker = createHttpServer();
    await new Promise<void>((resolveListen, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolveListen);
    });
    const blockedAddress = blocker.address();
    if (!blockedAddress || typeof blockedAddress === "string") throw new Error("Expected blocked TCP address.");
    await expect(startAccountNextServer({ appRoot, port: blockedAddress.port, hostname: "127.0.0.1", dev: false,
      environment: environment(14, "samurai_http_failed") })).rejects.toBeDefined();
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    expect((await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name = 'samurai_http_failed'",
    )).rows[0]?.count).toBe("0");
    const shell = await startAccountNextServer({
      appRoot, port: 0, hostname: "127.0.0.1", dev: false, environment: {},
    });
    const unavailable = await requestIssue(portOf(shell));
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toBe(JSON.stringify({
      code: "SERVICE_UNAVAILABLE", message: "The account service is unavailable.",
    }));
    expect(unavailable.rawHeaders.join("\n").toLowerCase()).toContain("cache-control\nno-store");
    await shell.closeAll();
    server = await startAccountNextServer({ appRoot, port: 0, hostname: "127.0.0.1", dev: false,
      environment: environment(15, "samurai_http_second") });
    expect((await requestIssue(portOf(server))).status).toBe(200);
  });

  it("clears stale HttpOnly transport authority through one strict origin-bound reset", async () => {
    const stale = Buffer.alloc(32, 91).toString("base64url");
    const staleGuest = `__Host-samurai-guest=${stale}`;
    const stalePlayer = `__Host-samurai-player=${stale}`;
    expect((await requestJson(portOf(server), "/api/account/guest/issue", issueBody, staleGuest)).status).toBe(400);
    expect((await requestJson(portOf(server), "/api/account/claim/recovery/challenge",
      JSON.stringify({ recoveryIntent: { recoverClaimId: randomUUID(), idempotencyKey: randomUUID() },
        account: testWallet().account }), stalePlayer)).status).toBe(400);
    const reset = await requestJson(portOf(server), "/api/account/cookies/reset", "{}",
      `${staleGuest}; __Host-samurai-guest-claim=${stale}; ${stalePlayer}`);
    expect(reset.status).toBe(200);
    expect(setCookies(reset.rawHeaders)).toEqual([
      "__Host-samurai-guest=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
      "__Host-samurai-guest-claim=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
      "__Host-samurai-player=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
    ]);
    expect((await requestIssue(portOf(server))).status).toBe(200);
  });

  it("maps missing, mixed, unknown, expired, tombstoned, and predecessor-expired service authority to one exact 401", async () => {
    const rejected = async (cookie?: string) => {
      const result = await requestJson(portOf(server), "/api/account/service", "{}", cookie);
      expect(result.status).toBe(401);
      expect(result.body).toBe(JSON.stringify({ code: "SERVICE_AUTHORITY_REJECTED", message: "Service access could not be authenticated." }));
      expect(setCookies(result.rawHeaders)).toEqual([]);
    };
    const unknown = Buffer.alloc(32, 92).toString("base64url");
    await rejected();
    await rejected(`__Host-samurai-guest=${unknown}; __Host-samurai-player=${unknown}`);
    await rejected(`__Host-samurai-guest=${unknown}`);
    await rejected(`__Host-samurai-player=${unknown}`);

    const expiredIssue = await requestJson(portOf(server), "/api/account/guest/issue", JSON.stringify({ consentVersion: "first-service-browser-v1" }));
    const expiredSecret = cookieValue(expiredIssue.rawHeaders, "__Host-samurai-guest");
    const expiredId = await guestIdFor(expiredSecret);
    await admin.query(`UPDATE samurai_persistence.guest_sessions
      SET created_at=clock_timestamp()-interval '40 days', last_seen_at=clock_timestamp()-interval '31 days',
          rotate_after=clock_timestamp()-interval '32 days', expires_at=clock_timestamp()-interval '1 millisecond'
      WHERE id=$1`, [expiredId]);
    await rejected(`__Host-samurai-guest=${expiredSecret}`);

    const deletedIssue = await requestJson(portOf(server), "/api/account/guest/issue", JSON.stringify({ consentVersion: "first-service-browser-v1" }));
    const deletedSecret = cookieValue(deletedIssue.rawHeaders, "__Host-samurai-guest");
    const deletedClaim = cookieValue(deletedIssue.rawHeaders, "__Host-samurai-guest-claim");
    expect((await requestJson(portOf(server), "/api/account/guest/delete", "{}", cookiePair(deletedSecret, deletedClaim))).status).toBe(200);
    await rejected(`__Host-samurai-guest=${deletedSecret}`);

    const rotatedIssue = await requestJson(portOf(server), "/api/account/guest/issue", JSON.stringify({ consentVersion: "first-service-browser-v1" }));
    const predecessorSecret = cookieValue(rotatedIssue.rawHeaders, "__Host-samurai-guest");
    const rotated = await requestJson(portOf(server), "/api/account/guest/rotate", "{}", `__Host-samurai-guest=${predecessorSecret}`);
    expect(rotated.status).toBe(200);
    const rotatedId = await guestIdFor(predecessorSecret);
    await admin.query("UPDATE samurai_persistence.guest_resume_digests SET valid_until=clock_timestamp()-interval '1 millisecond' WHERE guest_session_id=$1 AND slot='predecessor'", [rotatedId]);
    await rejected(`__Host-samurai-guest=${predecessorSecret}`);
  });

  it("refreshes rotation-due guest authority on the same subject and survives a lost refresh response", async () => {
    const issue = await requestJson(portOf(server), "/api/account/guest/issue", JSON.stringify({ consentVersion: "first-service-browser-v1" }));
    const secret = cookieValue(issue.rawHeaders, "__Host-samurai-guest");
    const claim = cookieValue(issue.rawHeaders, "__Host-samurai-guest-claim");
    const guestId = await guestIdFor(secret);
    const before = await requestJson(portOf(server), "/api/account/service", "{}", cookiePair(secret, claim));
    await admin.query("UPDATE samurai_persistence.guest_sessions SET rotate_after=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [guestId]);
    const refreshed = await requestJson(portOf(server), "/api/account/service", "{}", cookiePair(secret, claim));
    expect(refreshed.status).toBe(428);
    expect(refreshed.body).toBe(JSON.stringify({ code: "SERVICE_CREDENTIAL_REFRESHED", message: "Service access was refreshed. Requery the saved service." }));
    const rotatedSecret = cookieValue(refreshed.rawHeaders, "__Host-samurai-guest");
    expect(setCookies(refreshed.rawHeaders)).toHaveLength(1);
    const after = await requestJson(portOf(server), "/api/account/service", "{}", cookiePair(rotatedSecret, claim));
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body).view).toEqual(JSON.parse(before.body).view);
    expect((await admin.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM samurai_persistence.guest_sessions WHERE id=$1", [guestId])).rows[0]?.count).toBe("1");

    const lostIssue = await requestJson(portOf(server), "/api/account/guest/issue", JSON.stringify({ consentVersion: "first-service-browser-v1" }));
    const lostSecret = cookieValue(lostIssue.rawHeaders, "__Host-samurai-guest");
    const lostClaim = cookieValue(lostIssue.rawHeaders, "__Host-samurai-guest-claim");
    const lostId = await guestIdFor(lostSecret);
    await admin.query("UPDATE samurai_persistence.guest_sessions SET rotate_after=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [lostId]);
    await requestAndDropAfterCommit(portOf(server), "/api/account/service", "{}", cookiePair(lostSecret, lostClaim));
    const recovered = await requestJson(portOf(server), "/api/account/service", "{}", cookiePair(lostSecret, lostClaim));
    expect(recovered.status).toBe(200);
    expect(JSON.parse(recovered.body)).toMatchObject({ view: { identity: "guest", revision: 0, generation: 0 } });
  });

  it("starts fresh abandoned runs for the same guest and acknowledged player without cookie mutation", async () => {
    const command = (revision: number, commandName: string, payload: object = {}, idempotencyKey = randomUUID()) =>
      JSON.stringify({ idempotencyKey, expectedRevision: revision, commandName, payload });
    const issued = await requestJson(portOf(server), "/api/account/guest/issue", JSON.stringify({ consentVersion: "first-service-browser-v1" }));
    const guestSecret = cookieValue(issued.rawHeaders, "__Host-samurai-guest");
    const claimSecret = cookieValue(issued.rawHeaders, "__Host-samurai-guest-claim");
    const guestCookies = cookiePair(guestSecret, claimSecret);
    const guestStart = await requestJson(portOf(server), "/api/account/service/command", command(0, "service.start"), guestCookies);
    expect(guestStart.status, `guest start: ${guestStart.body}`).toBe(200);
    const guestAbandon = await requestJson(portOf(server), "/api/account/service/command", command(1, "service.abandon"), guestCookies);
    expect(guestAbandon.status, `guest abandon: ${guestAbandon.body}`).toBe(200);
    const guestFreshKey = randomUUID();
    const guestFreshBody = command(2, "service.start-new", {}, guestFreshKey);
    await requestAndDropAfterCommit(portOf(server), "/api/account/service/command", guestFreshBody, guestCookies);
    const guestQuery = await requestJson(portOf(server), "/api/account/service", "{}", guestCookies);
    expect(JSON.parse(guestQuery.body)).toMatchObject({ view: { identity: "guest", phase: "OPEN", generation: 1, revision: 3 } });
    const guestReplay = await requestJson(portOf(server), "/api/account/service/command", guestFreshBody, guestCookies);
    expect(JSON.parse(guestReplay.body)).toMatchObject({ view: { disposition: "replayed", phase: "OPEN", generation: 1, revision: 3, announceCeremony: false } });
    expect(setCookies(guestQuery.rawHeaders)).toEqual([]);
    expect(setCookies(guestReplay.rawHeaders)).toEqual([]);

    const wallet = testWallet();
    const playerIssue = await requestJson(portOf(server), "/api/account/guest/issue", JSON.stringify({ consentVersion: "first-service-browser-v1" }));
    const playerGuest = cookieValue(playerIssue.rawHeaders, "__Host-samurai-guest");
    const playerClaim = cookieValue(playerIssue.rawHeaders, "__Host-samurai-guest-claim");
    const playerGuestCookies = cookiePair(playerGuest, playerClaim);
    const playerStart = await requestJson(portOf(server), "/api/account/service/command", command(0, "service.start"), playerGuestCookies);
    expect(playerStart.status, `player start: ${playerStart.body}`).toBe(200);
    const playerAbandon = await requestJson(portOf(server), "/api/account/service/command", command(1, "service.abandon"), playerGuestCookies);
    expect(playerAbandon.status, `player abandon: ${playerAbandon.body}`).toBe(200);
    const intent = { claimId: randomUUID(), createPlayer: true, guestRevision: 2, idempotencyKey: randomUUID(),
      contentVersion: compiledFirstEveningService.contentVersion, cosmeticSelections: {} } as const;
    const challenged = await requestJson(portOf(server), "/api/account/claim/challenge", JSON.stringify({ intent, account: wallet.account }), playerGuestCookies);
    const challenge = challengeBody(challenged);
    const proof = { challenge: challenge.challenge, publicKey: wallet.publicKey, signature: wallet.sign(challenge.challenge) };
    const claimed = await requestJson(portOf(server), "/api/account/claim", JSON.stringify({ intent, challengeId: challenge.challengeId, proof }), playerGuestCookies);
    expect(claimed.status, `player claim: ${claimed.body}`).toBe(200);
    const claimPayload = JSON.parse(claimed.body) as { readonly playerId: string; readonly claimId: string; readonly sessionId: string; readonly deliveryGeneration: number };
    const playerSecret = cookieValue(claimed.rawHeaders, "__Host-samurai-player");
    const playerCookie = `__Host-samurai-player=${playerSecret}`;
    const delivery = await requestJson(portOf(server), "/api/account/claim/delivery", JSON.stringify({
      playerId: claimPayload.playerId, claimId: claimPayload.claimId, sessionId: claimPayload.sessionId,
      deliveryGeneration: claimPayload.deliveryGeneration,
    }), playerCookie);
    expect(delivery.status, `player delivery: ${delivery.body}`).toBe(200);
    const playerFresh = await requestJson(portOf(server), "/api/account/service/command", command(2, "service.start-new"), playerCookie);
    expect(playerFresh.status, `player fresh: ${playerFresh.body}`).toBe(200);
    expect(JSON.parse(playerFresh.body)).toMatchObject({ view: { identity: "player", phase: "OPEN", generation: 1, revision: 3 } });
    expect(setCookies(playerFresh.rawHeaders)).toEqual([]);
  });

  it("drives signed claim, exact delivery, lost-response recovery, and wallet deletion through production Next and PostgreSQL", async () => {
    const wallet = testWallet();
    const issued = await requestJson(portOf(server), "/api/account/guest/issue", JSON.stringify({ consentVersion: "first-service-browser-v1" }));
    const guest = cookieValue(issued.rawHeaders, "__Host-samurai-guest");
    const capability = cookieValue(issued.rawHeaders, "__Host-samurai-guest-claim");
    const guestCookies = cookiePair(guest, capability);
    const initialService = await requestJson(portOf(server), "/api/account/service", "{}", guestCookies);
    expect(initialService.status, initialService.body).toBe(200);
    expect(JSON.parse(initialService.body)).toMatchObject({ view: { disposition: "query", phase: "IDLE", revision: 0 } });
    const firstEntry = compiledFirstEveningService.goldenReplay[1] as { readonly command: { readonly idempotencyKey: string;
      readonly expectedRevision: number; readonly commandName: string; readonly payload: object } };
    const droppedServiceBody = JSON.stringify({ idempotencyKey: firstEntry.command.idempotencyKey,
      expectedRevision: firstEntry.command.expectedRevision, commandName: firstEntry.command.commandName,
      payload: firstEntry.command.payload });
    await requestAndDropAfterCommit(portOf(server), "/api/account/service/command", droppedServiceBody, guestCookies);
    const afterDroppedCommand = await requestJson(portOf(server), "/api/account/service", "{}", guestCookies);
    expect(JSON.parse(afterDroppedCommand.body)).toMatchObject({ view: { disposition: "query", revision: 1,
      prompt: { ref: "prompt.rice.wash" } } });
    const recoveredService = await requestJson(portOf(server), "/api/account/service/command", droppedServiceBody, guestCookies);
    expect(JSON.parse(recoveredService.body)).toMatchObject({ view: { disposition: "replayed", revision: 1,
      announceCeremony: false } });

    for (const entry of compiledFirstEveningService.goldenReplay.slice(2, 3)) {
      const command = (entry as { readonly command: { readonly idempotencyKey: string; readonly expectedRevision: number;
        readonly commandName: string; readonly payload: object } }).command;
      const guestServiceBody = JSON.stringify({ idempotencyKey: command.idempotencyKey, expectedRevision: command.expectedRevision,
        commandName: command.commandName, payload: command.payload });
      const serviceCommand = await requestJson(portOf(server), "/api/account/service/command", guestServiceBody, guestCookies);
      expect(serviceCommand.status, serviceCommand.body).toBe(200);
      expect(serviceCommand.body).not.toMatch(/guestId|playerId|subjectKind|resumeSecret|sessionSecret/);
    }
    const beforeClaimService = await requestJson(portOf(server), "/api/account/service", "{}", guestCookies);
    const beforeClaimView = (JSON.parse(beforeClaimService.body) as { readonly view: Record<string, unknown> }).view;
    expect(beforeClaimView).toMatchObject({ phase: "OPEN", revision: 2, prompt: { ref: "prompt.rice.steam" } });
    const intent = {
      claimId: randomUUID(), createPlayer: true, guestRevision: 2, idempotencyKey: randomUUID(),
      contentVersion: compiledFirstEveningService.contentVersion, cosmeticSelections: {},
    } as const;
    const challenged = await requestJson(portOf(server), "/api/account/claim/challenge",
      JSON.stringify({ intent, account: wallet.account }), guestCookies);
    expect(challenged.status).toBe(200);
    const challenge = challengeBody(challenged);
    const proof = { challenge: challenge.challenge, publicKey: wallet.publicKey, signature: wallet.sign(challenge.challenge) };
    const changed = await requestJson(portOf(server), "/api/account/claim",
      JSON.stringify({ intent: { ...intent, idempotencyKey: randomUUID() }, challengeId: challenge.challengeId, proof }), guestCookies);
    expect(changed.status).toBe(409);
    expect(setCookies(changed.rawHeaders)).toHaveLength(0);
    const claimed = await requestJson(portOf(server), "/api/account/claim",
      JSON.stringify({ intent, challengeId: challenge.challengeId, proof }), guestCookies);
    expect(claimed.status).toBe(200);
    const claimPayload = JSON.parse(claimed.body) as {
      readonly playerId: string; readonly claimId: string; readonly sessionId: string; readonly deliveryGeneration: number;
    };
    const claimResult = { playerId: claimPayload.playerId, claimId: claimPayload.claimId,
      sessionId: claimPayload.sessionId, deliveryGeneration: claimPayload.deliveryGeneration };
    expect(claimResult.claimId).toBe(intent.claimId);
    const playerSecret = cookieValue(claimed.rawHeaders, "__Host-samurai-player");
    const playerCookie = `__Host-samurai-player=${playerSecret}`;
    expect(setCookies(claimed.rawHeaders)).toEqual([
      "__Host-samurai-guest=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
      "__Host-samurai-guest-claim=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
      expect.stringMatching(/^__Host-samurai-player=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/),
    ]);
    expect(claimed.body).not.toContain(playerSecret);
    expect(claimed.body).not.toContain(proof.signature);
    const beforeClaimAck = await requestJson(portOf(server), "/api/account/player/session", "{}", playerCookie);
    expect(beforeClaimAck.status, `before claim acknowledgement: ${beforeClaimAck.body}`).toBe(401);
    const acknowledgement = JSON.stringify(claimResult);
    expect((await requestJson(portOf(server), "/api/account/claim/delivery", acknowledgement, playerCookie)).status).toBe(200);
    expect((await requestJson(portOf(server), "/api/account/player/session", "{}", playerCookie)).status).toBe(200);
    const afterClaimService = await requestJson(portOf(server), "/api/account/service", "{}", playerCookie);
    expect(afterClaimService.status, afterClaimService.body).toBe(200);
    const afterClaimView = (JSON.parse(afterClaimService.body) as { readonly view: Record<string, unknown> }).view;
    const { identity: _beforeIdentity, identityLabel: _beforeLabel, ...beforeProjection } = beforeClaimView;
    const { identity: afterIdentity, identityLabel: afterLabel, ...afterProjection } = afterClaimView;
    expect({ afterIdentity, afterLabel }).toEqual({ afterIdentity: "player", afterLabel: "Saved play · no wallet" });
    expect(afterProjection).toEqual(beforeProjection);
    let finalCommandBody = "";
    for (const entry of compiledFirstEveningService.goldenReplay.slice(3)) {
      const command = (entry as { readonly command: { readonly idempotencyKey: string; readonly expectedRevision: number;
        readonly commandName: string; readonly payload: object } }).command;
      finalCommandBody = JSON.stringify({ idempotencyKey: command.idempotencyKey, expectedRevision: command.expectedRevision,
        commandName: command.commandName, payload: command.payload });
      const serviceCommand = await requestJson(portOf(server), "/api/account/service/command", finalCommandBody, playerCookie);
      expect(serviceCommand.status, `${command.commandName}: ${serviceCommand.body}`).toBe(200);
      expect(JSON.parse(serviceCommand.body)).toMatchObject({ view: { disposition: "committed" } });
    }
    const settledService = await requestJson(portOf(server), "/api/account/service", "{}", playerCookie);
    expect(JSON.parse(settledService.body)).toMatchObject({ view: {
      phase: "SETTLED", unlock: { key: "dish-salmon-sashimi" }, revision: 29,
      disposition: "query", ledgerRows: [{ orderId: "ceramicist-kappa" },
      { orderId: "fishmonger-tamago" }, { orderId: "courier-salmon" }] } });

    const boundaryRuntime = await requestJson(portOf(server), "/api/account/wallet/runtime/sync", JSON.stringify({
      idempotencyKey: randomUUID(), runtimeGeneration: Number.MAX_SAFE_INTEGER, sessionRevision: 0,
      runtime: { providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc", account: wallet.account,
        permissionScopes: ["account"] },
    }), playerCookie);
    expect(boundaryRuntime.status, `boundary wallet runtime: ${boundaryRuntime.body}`).toBe(409);

    const runtimeBody = JSON.stringify({ idempotencyKey: randomUUID(), runtimeGeneration: 1, sessionRevision: 0,
      runtime: { providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc", account: wallet.account,
        permissionScopes: ["account"] } });
    const runtime = await requestJson(portOf(server), "/api/account/wallet/runtime/sync", runtimeBody, playerCookie);
    expect(runtime.status, `wallet runtime: ${runtime.body}`).toBe(200);
    const runtimeView = JSON.parse(runtime.body) as { readonly walletLinkRef: string; readonly runtimeGeneration: number;
      readonly sessionRevision: number; readonly credentialMatch: boolean; readonly state: string };
    expect(runtimeView).toMatchObject({ credentialMatch: true, state: "ACTIVE_CREDENTIAL_MATCH", runtimeGeneration: 1, sessionRevision: 1 });
    expect(runtime.body).not.toMatch(/playerId|sessionId|credentialId|publicKey|rawProvider|signature|permit|checkpoint|worker|lease/);

    const prepareKey = randomUUID();
    const prepareBody = JSON.stringify({ idempotencyKey: prepareKey, walletLinkRef: runtimeView.walletLinkRef,
      runtimeGeneration: runtimeView.runtimeGeneration, sessionRevision: runtimeView.sessionRevision });
    const prepared = await requestJson(portOf(server), "/api/account/receipt/review/prepare", prepareBody, playerCookie);
    expect(prepared.status, `receipt prepare: ${prepared.body}`).toBe(200);
    const projection = (JSON.parse(prepared.body) as { readonly projection: Record<string, unknown> }).projection;
    expect(projection).toMatchObject({ schemaVersion: 1, intent: { state: "REVIEWED" }, reviewFacts: {
      owner: wallet.account, source: wallet.account, destination: "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton",
      entrypoint: "submit_receipt", attachedMutez: "0" } });
    expect((await requestJson(portOf(server), "/api/account/receipt/review/prepare", prepareBody, playerCookie)).body).toBe(prepared.body);
    const restored = await requestJson(portOf(server), "/api/account/receipt/review/restore", "{}", playerCookie);
    expect(restored.status, restored.body).toBe(200);
    const restoredBody = JSON.parse(restored.body) as { readonly walletAccess: Record<string, unknown> };
    expect(restoredBody).toMatchObject({ schemaVersion: 1, doorway: {
      network: { profile: "localnet", chainId: "NetXtJqPyJGB6Pc", label: "Localnet rehearsal" },
      actionLabel: "Connect wallet for Localnet rehearsal",
    }, projection, walletAccess: { walletLinkRef: runtimeView.walletLinkRef, state: "ACTIVE_CREDENTIAL_MATCH",
      runtimeGeneration: runtimeView.runtimeGeneration, sessionRevision: runtimeView.sessionRevision } });

    const reviewDigest = createHash("sha256").update(canonicalJson(projection)).digest("hex");
    const receiptIntent = projection.intent as { readonly intentRef: string; readonly expiresAt: string };
    const preflightBody = JSON.stringify({ idempotencyKey: randomUUID(), walletLinkRef: runtimeView.walletLinkRef,
      runtimeGeneration: runtimeView.runtimeGeneration, sessionRevision: runtimeView.sessionRevision,
      publicIntentRef: receiptIntent.intentRef, expectedProjectionRevision: projection.projectionRevision, reviewDigest });
    const preflight = await requestJson(portOf(server), "/api/account/receipt/review/preflight", preflightBody, playerCookie);
    expect(preflight.status, preflight.body).toBe(200);
    expect(JSON.parse(preflight.body)).toMatchObject({ schemaVersion: 1, status: "REVIEW_READY", intentRef: receiptIntent.intentRef,
      walletLinkRef: runtimeView.walletLinkRef, reviewDigest });
    expect(preflight.body).not.toMatch(/callback|transport|signature|permit|operation|fee|playerId|sessionId|credentialId/);
    const stale = await requestJson(portOf(server), "/api/account/receipt/review/preflight", JSON.stringify({
      ...JSON.parse(preflightBody), idempotencyKey: randomUUID(), sessionRevision: runtimeView.sessionRevision + 1,
    }), playerCookie);
    expect(stale.status).toBe(200);
    expect(JSON.parse(stale.body)).toEqual({ schemaVersion: 1, status: "NOT_READY", reason: "WALLET_SESSION_REVISION_STALE" });
    const challengeRejected = await requestJson(portOf(server), "/api/account/wallet/link/challenge", JSON.stringify({
      idempotencyKey: randomUUID(), walletLinkRef: runtimeView.walletLinkRef,
      runtimeGeneration: runtimeView.runtimeGeneration, sessionRevision: runtimeView.sessionRevision,
    }), playerCookie);
    expect(challengeRejected.status, `active-credential challenge: ${challengeRejected.body}`).toBe(409);
    const proofRejected = await requestJson(portOf(server), "/api/account/wallet/link/proof", JSON.stringify({
      idempotencyKey: randomUUID(), walletLinkRef: runtimeView.walletLinkRef, challengeId: randomUUID(),
      proof: { challenge: {}, publicKey: "invalid", signature: "invalid" },
    }), playerCookie);
    expect(proofRejected.status, `malformed fixture proof: ${proofRejected.body}`).toBe(409);
    const disconnectBody = JSON.stringify({ idempotencyKey: randomUUID(), walletLinkRef: runtimeView.walletLinkRef,
      runtimeGeneration: runtimeView.runtimeGeneration, sessionRevision: runtimeView.sessionRevision });
    const disconnected = await requestJson(portOf(server), "/api/account/wallet/link/disconnect", disconnectBody, playerCookie);
    expect(disconnected.status, `wallet disconnect: ${disconnected.body}`).toBe(200);
    expect(JSON.parse(disconnected.body)).toMatchObject({ state: "DISCONNECTED", credentialMatch: false,
      runtimeGeneration: runtimeView.runtimeGeneration + 1, sessionRevision: runtimeView.sessionRevision + 1 });
    const disconnectedReplay = await requestJson(portOf(server), "/api/account/wallet/link/disconnect", disconnectBody, playerCookie);
    expect(disconnectedReplay.status, `wallet disconnect replay: ${disconnectedReplay.body}`).toBe(200);
    expect(disconnectedReplay.body).toBe(disconnected.body);
    const reconnected = await requestJson(portOf(server), "/api/account/wallet/runtime/sync", JSON.stringify({
      idempotencyKey: randomUUID(), runtimeGeneration: runtimeView.runtimeGeneration + 1, sessionRevision: 0,
      runtime: { providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc", account: wallet.account,
        permissionScopes: ["account"] },
    }), playerCookie);
    expect(reconnected.status, `wallet reconnect after restore retirement: ${reconnected.body}`).toBe(200);
    const reconnectedView = JSON.parse(reconnected.body) as typeof runtimeView;
    expect(reconnectedView).toMatchObject({ state: "ACTIVE_CREDENTIAL_MATCH", credentialMatch: true,
      runtimeGeneration: runtimeView.runtimeGeneration + 1, sessionRevision: 1 });
    const restoredReconnect = await requestJson(portOf(server), "/api/account/receipt/review/restore", "{}", playerCookie);
    expect(JSON.parse(restoredReconnect.body)).toMatchObject({ projection,
      walletAccess: { walletLinkRef: reconnectedView.walletLinkRef, state: "ACTIVE_CREDENTIAL_MATCH" } });
    const reconnectDisconnect = await requestJson(portOf(server), "/api/account/wallet/link/disconnect", JSON.stringify({
      idempotencyKey: randomUUID(), walletLinkRef: reconnectedView.walletLinkRef,
      runtimeGeneration: reconnectedView.runtimeGeneration, sessionRevision: reconnectedView.sessionRevision,
    }), playerCookie);
    expect(reconnectDisconnect.status, reconnectDisconnect.body).toBe(200);
    const serviceMatrixBeforeReplay = (await admin.query<{ events: string; outbox: string; receipts: string }>(`SELECT
      (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE player_id=$1 AND event_type LIKE 'service.%') AS events,
      (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e ON e.event_id=o.event_id
        WHERE e.player_id=$1 AND e.event_type LIKE 'service.%') AS outbox,
      (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE player_id=$1 AND command_name LIKE 'service.%') AS receipts`,
    [claimPayload.playerId])).rows[0]!;
    expect(serviceMatrixBeforeReplay).toEqual({ events: "29", outbox: "29", receipts: "29" });
    const exactSettlementReplay = await requestJson(portOf(server), "/api/account/service/command", finalCommandBody, playerCookie);
    expect(JSON.parse(exactSettlementReplay.body)).toMatchObject({ view: { disposition: "replayed",
      phase: "SETTLED", unlock: { key: "dish-salmon-sashimi" }, announceCeremony: false } });
    const serviceMatrixAfterReplay = (await admin.query<{ events: string; outbox: string; receipts: string }>(`SELECT
      (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE player_id=$1 AND event_type LIKE 'service.%') AS events,
      (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e ON e.event_id=o.event_id
        WHERE e.player_id=$1 AND e.event_type LIKE 'service.%') AS outbox,
      (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE player_id=$1 AND command_name LIKE 'service.%') AS receipts`,
    [claimPayload.playerId])).rows[0]!;
    expect(serviceMatrixAfterReplay).toEqual(serviceMatrixBeforeReplay);
    const rotated = await requestJson(portOf(server), "/api/account/player/session/rotate", "{}", playerCookie);
    expect(rotated.status, `player rotation after review: ${rotated.body}`).toBe(200);
    const rotatedSecret = cookieValue(rotated.rawHeaders, "__Host-samurai-player");
    const rotatedCookie = `__Host-samurai-player=${rotatedSecret}`;
    const rotatedPayload = JSON.parse(rotated.body) as typeof claimResult;
    const rotatedCoordinates = { playerId: rotatedPayload.playerId, claimId: rotatedPayload.claimId,
      sessionId: rotatedPayload.sessionId, deliveryGeneration: rotatedPayload.deliveryGeneration };
    const rotatedDelivery = await requestJson(portOf(server), "/api/account/claim/delivery",
      JSON.stringify(rotatedCoordinates), rotatedCookie);
    expect(rotatedDelivery.status, `rotated delivery after review: ${rotatedDelivery.body}`).toBe(200);
    const rotatedSession = await requestJson(portOf(server), "/api/account/player/session", "{}", rotatedCookie);
    expect(rotatedSession.status, `rotated session after review: ${rotatedSession.body}`).toBe(200);
    const replay = await requestJson(portOf(server), "/api/account/claim",
      JSON.stringify({ intent, challengeId: challenge.challengeId, proof }), guestCookies);
    expect(replay.status, `claim replay after delivery: ${replay.body}`).toBe(409);
    expect(setCookies(replay.rawHeaders)).toHaveLength(0);

    const expiredWallet = testWallet();
    const expiredIssue = await requestIssue(portOf(server));
    const expiredCookies = cookiePair(
      cookieValue(expiredIssue.rawHeaders, "__Host-samurai-guest"),
      cookieValue(expiredIssue.rawHeaders, "__Host-samurai-guest-claim"),
    );
    const expiredIntent = { ...intent, claimId: randomUUID(), idempotencyKey: randomUUID(), guestRevision: 0, contentVersion: "v1" };
    const expiring = await requestJson(portOf(server), "/api/account/claim/challenge",
      JSON.stringify({ intent: expiredIntent, account: expiredWallet.account }), expiredCookies);
    expect(expiring.status, `expiring challenge: ${expiring.body}`).toBe(200);
    const expiredChallenge = challengeBody(expiring);
    await admin.query(`WITH sampled AS (SELECT clock_timestamp() AS now)
      UPDATE samurai_persistence.claim_challenges
         SET issued_at=sampled.now - interval '5 minutes', expires_at=sampled.now
        FROM sampled WHERE challenge_id=$1::uuid`, [expiredChallenge.challengeId]);
    const expiredProof = { challenge: expiredChallenge.challenge, publicKey: expiredWallet.publicKey,
      signature: expiredWallet.sign(expiredChallenge.challenge) };
    const expired = await requestJson(portOf(server), "/api/account/claim",
      JSON.stringify({ intent: expiredIntent, challengeId: expiredChallenge.challengeId, proof: expiredProof }), expiredCookies);
    expect(expired.status).toBe(409);
    expect(setCookies(expired.rawHeaders)).toHaveLength(0);

    const lostWallet = testWallet();
    const lostGuestIssue = await requestIssue(portOf(server));
    const lostGuest = cookieValue(lostGuestIssue.rawHeaders, "__Host-samurai-guest");
    const lostCapability = cookieValue(lostGuestIssue.rawHeaders, "__Host-samurai-guest-claim");
    const lostGuestCookies = cookiePair(lostGuest, lostCapability);
    const lostIntent = { ...intent, claimId: randomUUID(), idempotencyKey: randomUUID(), guestRevision: 0, contentVersion: "v1" };
    const lostChallengeResult = await requestJson(portOf(server), "/api/account/claim/challenge",
      JSON.stringify({ intent: lostIntent, account: lostWallet.account }), lostGuestCookies);
    expect(lostChallengeResult.status, `lost-response challenge: ${lostChallengeResult.body}`).toBe(200);
    const lostChallenge = challengeBody(lostChallengeResult);
    const lostProof = { challenge: lostChallenge.challenge, publicKey: lostWallet.publicKey,
      signature: lostWallet.sign(lostChallenge.challenge) };
    const droppedClaim = await requestJson(portOf(server), "/api/account/claim",
      JSON.stringify({ intent: lostIntent, challengeId: lostChallenge.challengeId, proof: lostProof }), lostGuestCookies);
    expect(droppedClaim.status, `dropped claim: ${droppedClaim.body}`).toBe(200);
    const reauth = await requestJson(portOf(server), "/api/account/claim",
      JSON.stringify({ intent: lostIntent, challengeId: lostChallenge.challengeId, proof: lostProof }), lostGuestCookies);
    expect(reauth.status, `lost claim retry: ${reauth.body}`).toBe(401);
    expect(reauth.body).toBe(JSON.stringify(ACCOUNT_CLAIM_REAUTH_REQUIRED));
    expect(setCookies(reauth.rawHeaders)).toHaveLength(0);
    const recoveryIntent = { recoverClaimId: lostIntent.claimId, idempotencyKey: randomUUID() };
    const recoveryChallengeResult = await requestJson(portOf(server), "/api/account/claim/recovery/challenge",
      JSON.stringify({ recoveryIntent, account: lostWallet.account }));
    expect(recoveryChallengeResult.status, `recovery challenge: ${recoveryChallengeResult.body}`).toBe(200);
    const recoveryChallenge = challengeBody(recoveryChallengeResult);
    const recoveryProof = { challenge: recoveryChallenge.challenge, publicKey: lostWallet.publicKey,
      signature: lostWallet.sign(recoveryChallenge.challenge) };
    const recovered = await requestJson(portOf(server), "/api/account/claim/recovery",
      JSON.stringify({ recoveryIntent, challengeId: recoveryChallenge.challengeId, proof: recoveryProof }));
    expect(recovered.status, `recovered claim: ${recovered.body}`).toBe(200);
    const recoveredSecret = cookieValue(recovered.rawHeaders, "__Host-samurai-player");
    const recoveredCookie = `__Host-samurai-player=${recoveredSecret}`;
    const recoveredCoordinates = JSON.parse(recovered.body) as typeof claimResult;
    expect(recovered.body).not.toContain(recoveredSecret);
    const beforeRecoveryAck = await requestJson(portOf(server), "/api/account/player/session", "{}", recoveredCookie);
    expect(beforeRecoveryAck.status, `before recovery acknowledgement: ${beforeRecoveryAck.body}`).toBe(401);
    const recoveryAck = await requestJson(portOf(server), "/api/account/claim/delivery",
      JSON.stringify(recoveredCoordinates), recoveredCookie);
    expect(recoveryAck.status, recoveryAck.body).toBe(200);
    const afterRecoveryAck = await requestJson(portOf(server), "/api/account/player/session", "{}", recoveredCookie);
    expect(afterRecoveryAck.status, afterRecoveryAck.body).toBe(200);
    const recoveryReplay = await requestJson(portOf(server), "/api/account/claim/recovery",
      JSON.stringify({ recoveryIntent, challengeId: recoveryChallenge.challengeId, proof: recoveryProof }));
    expect(recoveryReplay.status, recoveryReplay.body).toBe(409);
    expect(setCookies(recoveryReplay.rawHeaders)).toHaveLength(0);

    const deletionIntent = { deleteClaimId: lostIntent.claimId, idempotencyKey: randomUUID() };
    const deletionChallengeResult = await requestJson(portOf(server), "/api/account/player/deletion/challenge",
      JSON.stringify({ deletionIntent, account: lostWallet.account }), recoveredCookie);
    expect(deletionChallengeResult.status, `deletion challenge: ${deletionChallengeResult.body}`).toBe(200);
    const deletionChallenge = challengeBody(deletionChallengeResult);
    const deletionProof = { challenge: deletionChallenge.challenge, publicKey: lostWallet.publicKey,
      signature: lostWallet.sign(deletionChallenge.challenge) };
    const deletionBody = JSON.stringify({ deletionIntent, challengeId: deletionChallenge.challengeId, proof: deletionProof });
    const deleted = await requestJson(portOf(server), "/api/account/player/deletion", deletionBody, recoveredCookie);
    expect(deleted.status, `deleted player: ${deleted.body}`).toBe(200);
    expect(setCookies(deleted.rawHeaders)).toContain(
      "__Host-samurai-player=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
    );
    const changedDeletion = await requestJson(portOf(server), "/api/account/player/deletion",
      JSON.stringify({ deletionIntent: { ...deletionIntent, idempotencyKey: randomUUID() },
        challengeId: deletionChallenge.challengeId, proof: deletionProof }), recoveredCookie);
    expect(changedDeletion.status).toBe(409);
    expect(setCookies(changedDeletion.rawHeaders)).toHaveLength(0);
    const deletionReplay = await requestJson(portOf(server), "/api/account/player/deletion", deletionBody, recoveredCookie);
    expect(deletionReplay.status).toBe(200);
    expect(setCookies(deletionReplay.rawHeaders)).toContain(
      "__Host-samurai-player=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
    );
    const deletedState = await admin.query<{ readonly players: string; readonly wallets: string; readonly sessions: string;
      readonly digests: string; readonly merges: string }>(`SELECT
        (SELECT count(*)::text FROM samurai_persistence.players WHERE id=$1) AS players,
        (SELECT count(*)::text FROM samurai_persistence.wallet_credentials WHERE player_id=$1) AS wallets,
        (SELECT count(*)::text FROM samurai_persistence.player_sessions WHERE player_id=$1) AS sessions,
        (SELECT count(*)::text FROM samurai_persistence.player_session_digests d
          JOIN samurai_persistence.player_sessions s ON s.id=d.player_session_id WHERE s.player_id=$1) AS digests,
        (SELECT count(*)::text FROM samurai_persistence.progress_merges WHERE player_id=$1) AS merges`,
    [recoveredCoordinates.playerId]);
    expect(deletedState.rows[0]).toEqual({ players: "0", wallets: "0", sessions: "0", digests: "0", merges: "0" });
  });

  it("keeps guest capability recovery cookie-only and converges rotation/delete response-loss retries", async () => {
    const issued = await requestIssue(portOf(server));
    const originalGuest = cookieValue(issued.rawHeaders, "__Host-samurai-guest");
    const originalCookie = `__Host-samurai-guest=${originalGuest}`;
    const resume = await requestJson(portOf(server), "/api/account/guest/resume", "{}", originalCookie);
    expect(resume.status).toBe(200);
    expect(resume.body).not.toContain(originalGuest);
    const capability = await requestJson(portOf(server), "/api/account/guest/claim-capability/rotate", "{}", originalCookie);
    expect(capability.status).toBe(200);
    expect(cookieValue(capability.rawHeaders, "__Host-samurai-guest-claim")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const dropped = await requestJson(portOf(server), "/api/account/guest/rotate", "{}", originalCookie);
    expect(dropped.status).toBe(200);
    const replacement = cookieValue(dropped.rawHeaders, "__Host-samurai-guest");
    const retries = await Promise.all([
      requestJson(portOf(server), "/api/account/guest/rotate", "{}", originalCookie),
      requestJson(portOf(server), "/api/account/guest/rotate", "{}", originalCookie),
    ]);
    expect(retries.map((result) => cookieValue(result.rawHeaders, "__Host-samurai-guest"))).toEqual([
      replacement, replacement,
    ]);
    const replacementCookie = `__Host-samurai-guest=${replacement}`;
    expect((await requestJson(portOf(server), "/api/account/guest/resume", "{}", replacementCookie)).status).toBe(200);
    const deleted = await requestJson(portOf(server), "/api/account/guest/delete", "{}", replacementCookie);
    expect(deleted.status).toBe(200);
    expect(setCookies(deleted.rawHeaders)).toEqual(expect.arrayContaining([
      "__Host-samurai-guest=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
      "__Host-samurai-guest-claim=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
    ]));
    expect((await requestJson(portOf(server), "/api/account/guest/delete", "{}", replacementCookie)).status).toBe(200);
    expect((await requestIssue(portOf(server))).status).toBe(200);
  });

  it("proves pending delivery, deterministic lost-response rotation, exact acknowledgement, and idempotent logout", async () => {
    const playerId = `player-http-${randomUUID()}`;
    const sessionId = randomUUID();
    const claimId = randomUUID();
    const initialSecret = Buffer.alloc(32, 41).toString("base64url");
    const now = (await admin.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    const bytes = Buffer.alloc(32, 12);
    const keys = new PlayerSessionKeyring({
      version: 1, key: bytes, keyIdentity: hmacKeyIdentity("player-session", bytes),
      activatedAt: new Date("2026-08-01T00:00:00.000Z"), retiredAt: null, verifyUntil: null, compromisedAt: null,
    });
    const digest = keys.digest(initialSecret, now);
    await admin.query(
      "INSERT INTO samurai_persistence.players (id,created_at,updated_at) VALUES ($1,$2,$2)", [playerId, now],
    );
    await admin.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,created_at,last_seen_at,expires_at,rotate_after)
       VALUES ($1,$2,'claim',$3,'pending-delivery',1,$4,$4,$5,$6)`,
      [sessionId, playerId, claimId, now, new Date(now.getTime() + 30 * 86_400_000), new Date(now.getTime() + 7 * 86_400_000)],
    );
    await admin.query(
      `INSERT INTO samurai_persistence.player_session_digests
        (player_session_id,slot,digest_key_version,digest_key_identity,digest,valid_until)
       VALUES ($1,'current',$2,$3,$4,NULL)`,
      [sessionId, digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest],
    );
    const initialCookie = `__Host-samurai-player=${initialSecret}`;
    expect((await requestJson(portOf(server), "/api/account/player/session", "{}", initialCookie)).status).toBe(401);
    const pendingService = await requestJson(portOf(server), "/api/account/service", "{}", initialCookie);
    expect(pendingService.status).toBe(401);
    expect(pendingService.body).toBe(JSON.stringify({ code: "SERVICE_AUTHORITY_REJECTED", message: "Service access could not be authenticated." }));
    const acknowledgement = JSON.stringify({ playerId, claimId, sessionId, deliveryGeneration: 1 });
    expect((await requestJson(portOf(server), "/api/account/claim/delivery", acknowledgement, initialCookie)).status).toBe(200);
    expect((await requestJson(portOf(server), "/api/account/claim/delivery", acknowledgement, initialCookie)).status).toBe(200);
    expect((await requestJson(portOf(server), "/api/account/player/session", "{}", initialCookie)).status).toBe(200);

    const dropped = await requestJson(portOf(server), "/api/account/player/session/rotate", "{}", initialCookie);
    expect(dropped.status).toBe(200);
    const droppedSecret = cookieValue(dropped.rawHeaders, "__Host-samurai-player");
    const retries = await Promise.all([
      requestJson(portOf(server), "/api/account/player/session/rotate", "{}", initialCookie),
      requestJson(portOf(server), "/api/account/player/session/rotate", "{}", initialCookie),
    ]);
    expect(retries.map((result) => result.status)).toEqual([200, 200]);
    expect(retries.map((result) => cookieValue(result.rawHeaders, "__Host-samurai-player"))).toEqual([
      droppedSecret, droppedSecret,
    ]);
    const replacementCookie = `__Host-samurai-player=${droppedSecret}`;
    expect((await requestJson(portOf(server), "/api/account/player/session", "{}", replacementCookie)).status).toBe(401);
    expect((await requestJson(portOf(server), "/api/account/claim/delivery",
      JSON.stringify({ playerId, claimId, sessionId, deliveryGeneration: 1 }), replacementCookie)).status).toBe(409);
    const replacementAck = JSON.stringify({ playerId, claimId, sessionId, deliveryGeneration: 2 });
    expect((await requestJson(portOf(server), "/api/account/claim/delivery", replacementAck, replacementCookie)).status).toBe(200);
    expect((await requestJson(portOf(server), "/api/account/claim/delivery", replacementAck, replacementCookie)).status).toBe(200);
    expect((await requestJson(portOf(server), "/api/account/player/session", "{}", replacementCookie)).status).toBe(200);
    const logout = await requestJson(portOf(server), "/api/account/player/logout", "{}", replacementCookie);
    expect(logout.status).toBe(200);
    expect(setCookies(logout.rawHeaders)).toContain(
      "__Host-samurai-player=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
    );
    const logoutReplay = await requestJson(portOf(server), "/api/account/player/logout", "{}", replacementCookie);
    expect(logoutReplay.status).toBe(200);
    const revokedService = await requestJson(portOf(server), "/api/account/service", "{}", replacementCookie);
    expect(revokedService.status).toBe(401);
    expect(revokedService.body).toBe(JSON.stringify({ code: "SERVICE_AUTHORITY_REJECTED", message: "Service access could not be authenticated." }));
    expect(setCookies(revokedService.rawHeaders)).toEqual([]);
    expect((await admin.query<{ state: string }>(
      "SELECT state FROM samurai_persistence.player_sessions WHERE id=$1", [sessionId],
    )).rows[0]?.state).toBe("revoked");
    expect((await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM samurai_persistence.players WHERE id=$1", [playerId],
    )).rows[0]?.count).toBe("1");
  });

  it("refreshes a verification-only-key current guest after an immutable runtime key transition", async () => {
    const issue = await requestJson(portOf(server), "/api/account/guest/issue", JSON.stringify({ consentVersion: "first-service-browser-v1" }));
    const oldSecret = cookieValue(issue.rawHeaders, "__Host-samurai-guest");
    const claim = cookieValue(issue.rawHeaders, "__Host-samurai-guest-claim");
    const oldCookies = cookiePair(oldSecret, claim);
    const before = await requestJson(portOf(server), "/api/account/service", "{}", oldCookies);
    const guestId = await guestIdFor(oldSecret);

    await server.closeAll();
    const rotatedEnvironment = environment(16, "samurai_http_resume_key_two");
    rotatedEnvironment.SAMURAI_HMAC_RESUME_KEY = Buffer.alloc(32, 19).toString("base64url");
    rotatedEnvironment.SAMURAI_HMAC_RESUME_PREVIOUS_KEY = Buffer.alloc(32, 9).toString("base64url");
    rotatedEnvironment.SAMURAI_HMAC_RESUME_PREVIOUS_RETIRED_AT = "2026-08-01T01:00:00.000Z";
    rotatedEnvironment.SAMURAI_HMAC_RESUME_PREVIOUS_VERIFY_UNTIL = "2027-01-01T00:00:00.000Z";
    server = await startAccountNextServer({ appRoot, port: 0, hostname: "127.0.0.1", dev: false, environment: rotatedEnvironment });

    const refreshed = await requestJson(portOf(server), "/api/account/service", "{}", oldCookies);
    expect(refreshed.status).toBe(428);
    expect(refreshed.body).toBe(JSON.stringify({ code: "SERVICE_CREDENTIAL_REFRESHED", message: "Service access was refreshed. Requery the saved service." }));
    const newSecret = cookieValue(refreshed.rawHeaders, "__Host-samurai-guest");
    const after = await requestJson(portOf(server), "/api/account/service", "{}", cookiePair(newSecret, claim));
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body).view).toEqual(JSON.parse(before.body).view);
    expect((await admin.query<{ readonly id: string }>(
      "SELECT id FROM samurai_persistence.guest_sessions WHERE id=$1", [guestId],
    )).rows[0]?.id).toBe(guestId);
  });

  it("keeps Node authority and representative secret/config markers out of client chunks, maps, HTML, and RSC payloads", async () => {
    const staticRoot = resolve(appRoot, ".next/static");
    const staticFiles = (await readdir(staticRoot, { recursive: true })).filter((file) => file.endsWith(".js") || file.endsWith(".map"));
    const appOutputRoot = resolve(appRoot, ".next/server/app");
    const appFiles = (await readdir(appOutputRoot, { recursive: true })).filter((file) => /\.(?:html|rsc|txt)$/u.test(file));
    const source = (await Promise.all([
      ...staticFiles.map((file) => readFile(resolve(staticRoot, file), "utf8")),
      ...appFiles.map((file) => readFile(resolve(appOutputRoot, file), "utf8")),
    ])).join("\n");
    for (const marker of ["account-http-runtime", "@samurai-sushi/persistence", "service-authority",
      "@samurai-sushi/content", "account-proof-verifier", "claim-protocol", "node:crypto", "pg-pool", "@taquito", "@noble",
      "SAMURAI_DATABASE_URL", "SAMURAI_HMAC_RESUME_KEY", "SAMURAI_HMAC_GUEST_CLAIM_KEY",
      "x-samurai-raw-header-guard", "__Host-samurai", "postgresql://", "challengeId", "claimId", "guestId", "playerId",
      "subjectId", "resultHash", "playerSessionId", "credentialId", "issuerSignature", "executablePermit", "checkpoint", "edpk",
      "issueSettledReceiptPermit", "admitSettledReceiptPermit", "deriveSettledServiceReceiptFacts",
      "FIXTURE_SETTLED_COMMITMENT_NONCE", "deterministicSettledCheckpointFixture", "commitmentNonce",
      "rpc.shadownet.teztnets.com", "api.shadownet.tzkt.io", "127.0.0.1:8732"]) {
      expect(source).not.toContain(marker);
    }
  });
});

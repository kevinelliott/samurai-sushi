import {
  ACCOUNT_CLAIM_PUBLIC_FAILURE,
  ACCOUNT_CLAIM_REAUTH_REQUIRED,
  ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE,
  ACCOUNT_PLAYER_DELETE_PUBLIC_FAILURE,
  ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE,
  ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED,
  CommandAuthenticationError,
  GuestRotationDeferredError,
  type AccountClaimService,
  type EveningServiceAuthority,
  type GuestSessionService,
  type ReceiptReviewWalletAuthority,
  type ServiceSubjectCredential,
} from "@samurai-sushi/persistence";
import { buildBrowserEveningServiceView, compiledFirstEveningService } from "@samurai-sushi/content";
import type { JsonObject } from "@samurai-sushi/domain";
import { createInitialEveningServiceCheckpoint, projectEveningService, type EveningServiceCheckpoint } from "@samurai-sushi/domain/evening-service";
import { ACCOUNT_COOKIE_NAMES, clearAccountCookie, CookieRejectedError, parseAccountCookies, setAccountCookie } from "./cookies";
import {
  ACCOUNT_ROUTE_PATHS,
  MAX_JSON_BODY_BYTES,
  PUBLIC_HTTP_FAILURES,
  RAW_HEADER_GUARD,
  type AccountRouteId,
} from "./contract";
import type { AccountRuntimeConfig } from "./config";
import { BodyTooLargeError, parseStrictJson, plainObject, StrictJsonError, strictObject } from "./strict-json";

export interface AccountHttpServices {
  readonly guests: GuestSessionService;
  readonly accounts: AccountClaimService;
  readonly evening: EveningServiceAuthority;
  readonly receiptReview: ReceiptReviewWalletAuthority | null;
}

export interface AccountHttpLogEvent {
  readonly event: "account_http_completed" | "account_http_rejected";
  readonly operation: AccountRouteId;
  readonly resultCode: string;
}

export type AccountHttpLogger = (event: AccountHttpLogEvent) => void;

const noopLogger: AccountHttpLogger = () => undefined;

class ServiceAuthorityCookieError extends Error {}

function emit(logger: AccountHttpLogger, event: AccountHttpLogEvent): void {
  const safe = Object.freeze({ event: event.event, operation: event.operation, resultCode: event.resultCode });
  try { logger(safe); } catch { /* Logging cannot affect the public transport result. */ }
}

function response(status: number, body: Readonly<Record<string, unknown>>, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Vary": "Cookie",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(
  operation: AccountRouteId,
  logger: AccountHttpLogger,
  item: { readonly status: number; readonly body: Readonly<Record<string, unknown>> },
): Response {
  emit(logger, { event: "account_http_rejected", operation, resultCode: String(item.body.code ?? "REJECTED") });
  return response(item.status, item.body);
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code : null;
}

async function refreshGuestServiceCredential(
  operation: AccountRouteId,
  request: Request,
  services: AccountHttpServices,
  logger: AccountHttpLogger,
): Promise<Response> {
  const guest = parseAccountCookies(request.headers.get("cookie")).get(ACCOUNT_COOKIE_NAMES.guest);
  if (!guest) return failure(operation, logger, PUBLIC_HTTP_FAILURES.serviceAuthentication);
  try {
    const resumed = await services.guests.resume(guest);
    const outgoing = resumed.rotatedResumeSecret ? [setAccountCookie("guest", resumed.rotatedResumeSecret)] : [];
    emit(logger, { event: "account_http_rejected", operation, resultCode: PUBLIC_HTTP_FAILURES.serviceCredentialRefreshed.body.code });
    return response(PUBLIC_HTTP_FAILURES.serviceCredentialRefreshed.status,
      PUBLIC_HTTP_FAILURES.serviceCredentialRefreshed.body, outgoing);
  } catch (error) {
    if (["GUEST_RESUME_INVALID", "GUEST_RESUME_EXPIRED", "GUEST_SECRET_TOMBSTONED"].includes(errorCode(error) ?? "")) {
      return failure(operation, logger, PUBLIC_HTTP_FAILURES.serviceAuthentication);
    }
    return failure(operation, logger, PUBLIC_HTTP_FAILURES.service);
  }
}

async function readStrictBody(request: Request): Promise<Readonly<Record<string, unknown>>> {
  if (request.headers.get("content-type") !== "application/json" || request.headers.has("content-encoding")) {
    throw new StrictJsonError();
  }
  const length = request.headers.get("content-length");
  if (length !== null && !/^(?:0|[1-9][0-9]*)$/.test(length)) {
    throw new StrictJsonError();
  }
  if (length !== null && Number(length) > MAX_JSON_BODY_BYTES) throw new BodyTooLargeError();
  if (!request.body) throw new StrictJsonError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (length !== null && Number(length) !== total) throw new StrictJsonError();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new StrictJsonError(); }
  return plainObject(parseStrictJson(text));
}

function exactEmpty(body: unknown): void { strictObject(body, []); }

function text(value: unknown): string {
  if (typeof value !== "string") throw new StrictJsonError();
  return value;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new StrictJsonError();
  return value as number;
}

function proof(value: unknown): Readonly<Record<string, unknown>> {
  return strictObject(value, ["challenge", "publicKey", "signature"]);
}

function walletRuntime(value: unknown): Parameters<ReceiptReviewWalletAuthority["syncRuntime"]>[1]["runtime"] {
  const row = strictObject(value, ["providerId", "chainId", "account", "permissionScopes"]);
  if (!Array.isArray(row.permissionScopes) || row.permissionScopes.length !== 1 || row.permissionScopes[0] !== "account") {
    throw new StrictJsonError();
  }
  const providerId = text(row.providerId);
  if (providerId !== "localnet-wallet" && providerId !== "deterministic-wallet") throw new StrictJsonError();
  return { providerId, chainId: text(row.chainId), account: text(row.account), permissionScopes: ["account"] };
}

function claimTransportIntent(value: unknown, capability: string): Readonly<Record<string, unknown>> {
  const base = strictObject(value, ["claimId", "createPlayer", "guestRevision", "idempotencyKey", "contentVersion", "cosmeticSelections"],
    ["targetPlayerId", "playerRevision"]);
  if (typeof base.createPlayer !== "boolean") throw new StrictJsonError();
  const expected = base.createPlayer
    ? ["claimId", "createPlayer", "guestRevision", "idempotencyKey", "contentVersion", "cosmeticSelections"]
    : ["claimId", "targetPlayerId", "createPlayer", "guestRevision", "playerRevision", "idempotencyKey", "contentVersion", "cosmeticSelections"];
  strictObject(base, expected);
  return { ...base, guestClaimCommitment: capability };
}

function publicResult(value: unknown): value is { readonly code: string; readonly message: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { code?: unknown }).code === "string"
    && typeof (value as { message?: unknown }).message === "string");
}

function resultFailure(operation: AccountRouteId, logger: AccountHttpLogger, result: unknown): Response | null {
  if (!publicResult(result)) return null;
  const allowed = [
    [ACCOUNT_CLAIM_PUBLIC_FAILURE, 409],
    [ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE, 409],
    [ACCOUNT_CLAIM_REAUTH_REQUIRED, 401],
    [ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE, 401],
    [ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED, 409],
    [ACCOUNT_PLAYER_DELETE_PUBLIC_FAILURE, 409],
  ] as const;
  for (const [item, status] of allowed) {
    if (result.code === item.code && result.message === item.message) {
      return failure(operation, logger, { status, body: item });
    }
  }
  return failure(operation, logger, PUBLIC_HTTP_FAILURES.request);
}

function requireCookie(cookies: ReadonlyMap<string, string>, kind: keyof typeof ACCOUNT_COOKIE_NAMES): string {
  const value = cookies.get(ACCOUNT_COOKIE_NAMES[kind]);
  if (!value) throw new StrictJsonError();
  return value;
}

function assertAuthorityCookieInventory(
  operation: AccountRouteId,
  cookies: ReadonlyMap<string, string>,
): void {
  const present = (Object.entries(ACCOUNT_COOKIE_NAMES) as readonly [keyof typeof ACCOUNT_COOKIE_NAMES, string][])
    .filter(([, name]) => cookies.has(name)).map(([kind]) => kind).sort();
  const key = present.join(",");
  const allowed: Readonly<Record<AccountRouteId, readonly string[]>> = {
    "cookies.reset": ["", "guest", "claim", "player", "claim,guest", "guest,player", "claim,player", "claim,guest,player"],
    "guest.issue": [""],
    "guest.resume": ["guest", "claim,guest"],
    "guest.rotate": ["guest", "claim,guest"],
    "guest.delete": ["guest", "claim,guest"],
    "guest.claim-capability.rotate": ["guest", "claim,guest"],
    "claim.challenge": ["claim,guest"],
    "claim.submit": ["claim,guest"],
    "recovery.challenge": ["", "claim", "guest", "claim,guest"],
    "recovery.submit": ["", "claim", "guest", "claim,guest"],
    "claim.delivery": ["player"],
    "player.authenticate": ["player"],
    "player.rotate": ["player"],
    "player.logout": ["player"],
    "deletion.challenge": ["", "player"],
    "deletion.submit": ["", "player"],
    "service.query": ["guest", "claim,guest", "player"],
    "service.command": ["guest", "claim,guest", "player"],
    "receipt.review.prepare": ["guest", "claim,guest", "player"],
    "receipt.review.restore": ["guest", "claim,guest", "player"],
    "wallet.runtime.sync": ["guest", "claim,guest", "player"],
    "wallet.link.challenge": ["guest", "claim,guest", "player"],
    "wallet.link.proof": ["guest", "claim,guest", "player"],
    "wallet.link.disconnect": ["guest", "claim,guest", "player"],
    "receipt.review.preflight": ["guest", "claim,guest", "player"],
  };
  if (!allowed[operation].includes(key)) {
    if (operation === "service.query" || operation === "service.command") throw new ServiceAuthorityCookieError();
    throw new StrictJsonError();
  }
}

function serviceCredential(cookies: ReadonlyMap<string, string>): ServiceSubjectCredential {
  const guest = cookies.get(ACCOUNT_COOKIE_NAMES.guest);
  const player = cookies.get(ACCOUNT_COOKIE_NAMES.player);
  if (guest && !player) return { kind: "guest", resumeSecret: guest };
  if (player && !guest && !cookies.has(ACCOUNT_COOKIE_NAMES.claim)) return { kind: "player", sessionSecret: player };
  throw new ServiceAuthorityCookieError();
}

function serviceView(
  checkpoint: EveningServiceCheckpoint,
  credential: ServiceSubjectCredential,
  disposition: "query" | "committed" | "replayed",
  correctiveCueId: string | null,
): Readonly<Record<string, unknown>> {
  const projection = projectEveningService(checkpoint, compiledFirstEveningService.projectionManifest, {
    disposition,
    correctiveCueId,
  });
  return buildBrowserEveningServiceView(checkpoint, projection, credential.kind) as unknown as Readonly<Record<string, unknown>>;
}

function assertRequestAuthority(request: Request, operation: AccountRouteId, config: AccountRuntimeConfig): void {
  const expectedPath = ACCOUNT_ROUTE_PATHS.get(operation);
  const url = new URL(request.url);
  const canonical = new URL(config.canonicalOrigin);
  const expectedProto = canonical.protocol.slice(0, -1);
  const expectedPort = canonical.port || (expectedProto === "https" ? "443" : "80");
  if (request.method !== "POST" || !expectedPath || url.pathname !== expectedPath || url.search || url.hash
    || request.headers.get("origin") !== config.canonicalOrigin
    || request.headers.get("host") !== canonical.host || request.headers.get(RAW_HEADER_GUARD) !== config.rawHeaderGuard
    || request.headers.has("forwarded") || request.headers.get("x-forwarded-host") !== canonical.host
    || request.headers.get("x-forwarded-proto") !== expectedProto
    || request.headers.get("x-forwarded-port") !== expectedPort) {
    throw new StrictJsonError();
  }
}

export async function handleAccountHttpRequest(
  operation: AccountRouteId,
  request: Request,
  services: AccountHttpServices,
  config: AccountRuntimeConfig,
  logger: AccountHttpLogger = noopLogger,
): Promise<Response> {
  try {
    assertRequestAuthority(request, operation, config);
    const cookies = parseAccountCookies(request.headers.get("cookie"));
    assertAuthorityCookieInventory(operation, cookies);
    const body = await readStrictBody(request);
    let result: unknown;
    let outgoing: readonly string[] = [];
    let payload: Readonly<Record<string, unknown>> = { ok: true };

    switch (operation) {
      case "cookies.reset": {
        exactEmpty(body);
        outgoing = [clearAccountCookie("guest"), clearAccountCookie("claim"), clearAccountCookie("player")];
        break;
      }
      case "guest.issue": {
        const browserIssue = Object.keys(body).length === 1 && Object.hasOwn(body, "consentVersion");
        const input = browserIssue
          ? strictObject(body, ["consentVersion"])
          : strictObject(body, ["consentVersion", "contentVersion", "checkpointSchemaVersion", "checkpoint"]);
        if (browserIssue && input.consentVersion !== "first-service-browser-v1") throw new StrictJsonError();
        const initial = createInitialEveningServiceCheckpoint();
        const issued = await services.guests.issue({
          consentVersion: text(input.consentVersion),
          contentVersion: browserIssue ? initial.contentVersion : text(input.contentVersion),
          checkpointSchemaVersion: browserIssue ? initial.schemaVersion : safeInteger(input.checkpointSchemaVersion),
          checkpoint: browserIssue ? initial : plainObject(input.checkpoint),
        });
        if (!issued.claimCapability) throw new StrictJsonError();
        outgoing = [setAccountCookie("guest", issued.resumeSecret), setAccountCookie("claim", issued.claimCapability)];
        payload = browserIssue ? { issued: true }
          : { guestId: issued.session.id, expiresAt: issued.session.expiresAt.toISOString(), revision: issued.progress.revision };
        break;
      }
      case "guest.resume": {
        exactEmpty(body);
        const resumed = await services.guests.resume(requireCookie(cookies, "guest"));
        outgoing = resumed.rotatedResumeSecret ? [setAccountCookie("guest", resumed.rotatedResumeSecret)] : [];
        payload = { guestId: resumed.session.id, expiresAt: resumed.session.expiresAt.toISOString(),
          credentialKind: resumed.credentialKind };
        break;
      }
      case "guest.rotate": {
        exactEmpty(body);
        const rotated = await services.guests.rotate(requireCookie(cookies, "guest"));
        outgoing = [setAccountCookie("guest", rotated.rotatedResumeSecret)];
        payload = { guestId: rotated.session.id, expiresAt: rotated.session.expiresAt.toISOString() };
        break;
      }
      case "guest.delete": {
        exactEmpty(body);
        await services.guests.delete(requireCookie(cookies, "guest"));
        outgoing = [clearAccountCookie("guest"), clearAccountCookie("claim")];
        break;
      }
      case "guest.claim-capability.rotate": {
        exactEmpty(body);
        const rotated = await services.guests.rotateClaimCapability(requireCookie(cookies, "guest"));
        outgoing = [setAccountCookie("claim", rotated.claimCapability)];
        payload = { expiresAt: rotated.expiresAt.toISOString() };
        break;
      }
      case "claim.challenge": {
        const input = strictObject(body, ["intent", "account"]);
        result = await services.accounts.issueClaimChallenge({
          resumeSecret: requireCookie(cookies, "guest"),
          intent: claimTransportIntent(input.intent, requireCookie(cookies, "claim")),
          account: text(input.account),
        });
        const rejected = resultFailure(operation, logger, result); if (rejected) return rejected;
        payload = result as Readonly<Record<string, unknown>>;
        break;
      }
      case "claim.submit": {
        const input = strictObject(body, ["intent", "challengeId", "proof"]);
        result = await services.accounts.claimGuest({
          resumeSecret: requireCookie(cookies, "guest"),
          intent: claimTransportIntent(input.intent, requireCookie(cookies, "claim")),
          challengeId: text(input.challengeId),
          proof: proof(input.proof) as unknown as Parameters<AccountClaimService["claimGuest"]>[0]["proof"],
        });
        const rejected = resultFailure(operation, logger, result);
        if (rejected) return rejected;
        const claimed = result as Exclude<Awaited<ReturnType<AccountClaimService["claimGuest"]>>, { code: string }>;
        outgoing = [clearAccountCookie("guest"), clearAccountCookie("claim"), setAccountCookie("player", claimed.sessionSecret)];
        payload = { playerId: claimed.playerId, claimId: claimed.claimId, playerRevision: claimed.playerRevision,
          sessionId: claimed.sessionId, deliveryGeneration: claimed.deliveryGeneration, disposition: claimed.disposition };
        break;
      }
      case "recovery.challenge": {
        const input = strictObject(body, ["recoveryIntent", "account"]);
        result = await services.accounts.issueRecoveryChallenge({ recoveryIntent: input.recoveryIntent, account: text(input.account) });
        const rejected = resultFailure(operation, logger, result); if (rejected) return rejected;
        payload = result as Readonly<Record<string, unknown>>;
        break;
      }
      case "recovery.submit": {
        const input = strictObject(body, ["recoveryIntent", "challengeId", "proof"]);
        result = await services.accounts.recoverClaimSession({ recoveryIntent: input.recoveryIntent,
          challengeId: text(input.challengeId), proof: proof(input.proof) as unknown as Parameters<AccountClaimService["recoverClaimSession"]>[0]["proof"] });
        const rejected = resultFailure(operation, logger, result); if (rejected) return rejected;
        const recovered = result as Exclude<Awaited<ReturnType<AccountClaimService["recoverClaimSession"]>>, { code: string }>;
        outgoing = [clearAccountCookie("guest"), clearAccountCookie("claim"), setAccountCookie("player", recovered.sessionSecret)];
        payload = { playerId: recovered.playerId, claimId: recovered.claimId, sessionId: recovered.sessionId,
          deliveryGeneration: recovered.deliveryGeneration };
        break;
      }
      case "claim.delivery": {
        const input = strictObject(body, ["playerId", "claimId", "sessionId", "deliveryGeneration"]);
        result = await services.accounts.acknowledgeClaimDeliveryExact(text(input.playerId), text(input.claimId),
          text(input.sessionId), requireCookie(cookies, "player"), safeInteger(input.deliveryGeneration));
        const rejected = resultFailure(operation, logger, result); if (rejected) return rejected;
        break;
      }
      case "player.authenticate": {
        exactEmpty(body);
        result = await services.accounts.authenticatePlayerSession(requireCookie(cookies, "player"));
        const rejected = resultFailure(operation, logger, result); if (rejected) return rejected;
        payload = result as unknown as Readonly<Record<string, unknown>>;
        break;
      }
      case "player.rotate": {
        exactEmpty(body);
        result = await services.accounts.rotatePlayerSession(requireCookie(cookies, "player"));
        const rejected = resultFailure(operation, logger, result); if (rejected) return rejected;
        const rotated = result as Exclude<Awaited<ReturnType<AccountClaimService["rotatePlayerSession"]>>, { code: string }>;
        outgoing = [setAccountCookie("player", rotated.sessionSecret)];
        payload = { playerId: rotated.playerId, claimId: rotated.claimId, sessionId: rotated.sessionId,
          deliveryGeneration: rotated.deliveryGeneration, credentialKind: rotated.credentialKind,
          rotationRequired: rotated.rotationRequired };
        break;
      }
      case "player.logout": {
        exactEmpty(body);
        result = await services.accounts.logoutPlayerSession(requireCookie(cookies, "player"));
        const rejected = resultFailure(operation, logger, result); if (rejected) return rejected;
        outgoing = [clearAccountCookie("player")];
        break;
      }
      case "deletion.challenge": {
        const input = strictObject(body, ["deletionIntent", "account"]);
        result = await services.accounts.issuePlayerDeletionChallenge({ deletionIntent: input.deletionIntent, account: text(input.account) });
        const rejected = resultFailure(operation, logger, result); if (rejected) return rejected;
        payload = result as Readonly<Record<string, unknown>>;
        break;
      }
      case "deletion.submit": {
        const input = strictObject(body, ["deletionIntent", "challengeId", "proof"]);
        result = await services.accounts.deletePlayerWithWalletProof({ deletionIntent: input.deletionIntent,
          challengeId: text(input.challengeId), proof: proof(input.proof) as unknown as Parameters<AccountClaimService["deletePlayerWithWalletProof"]>[0]["proof"] });
        const rejected = resultFailure(operation, logger, result); if (rejected) return rejected;
        outgoing = [clearAccountCookie("player")];
        break;
      }
      case "service.query": {
        exactEmpty(body);
        const credential = serviceCredential(cookies);
        const queried = await services.evening.query(credential);
        payload = { view: serviceView(queried.checkpoint, credential, "query", null) };
        break;
      }
      case "service.command": {
        const input = strictObject(body, ["commandName", "expectedRevision", "idempotencyKey", "payload"]);
        const credential = serviceCredential(cookies);
        const executed = await services.evening.execute(credential, {
          commandName: text(input.commandName),
          expectedRevision: safeInteger(input.expectedRevision),
          idempotencyKey: text(input.idempotencyKey),
          payload: plainObject(input.payload) as JsonObject,
        });
        payload = { view: serviceView(executed.response.checkpoint, credential, executed.disposition, executed.response.correctiveCueId) };
        break;
      }
      case "wallet.runtime.sync": {
        if (!services.receiptReview) return failure(operation, logger, PUBLIC_HTTP_FAILURES.runtime);
        const input = strictObject(body, ["idempotencyKey", "runtimeGeneration", "sessionRevision", "runtime"]);
        payload = await services.receiptReview.syncRuntime(serviceCredential(cookies), {
          idempotencyKey: text(input.idempotencyKey), runtimeGeneration: safeInteger(input.runtimeGeneration),
          sessionRevision: safeInteger(input.sessionRevision), runtime: walletRuntime(input.runtime),
        }) as unknown as Readonly<Record<string, unknown>>;
        break;
      }
      case "wallet.link.challenge": {
        if (!services.receiptReview) return failure(operation, logger, PUBLIC_HTTP_FAILURES.runtime);
        const input = strictObject(body, ["idempotencyKey", "walletLinkRef", "runtimeGeneration", "sessionRevision"]);
        payload = await services.receiptReview.issueChallenge(serviceCredential(cookies), {
          idempotencyKey: text(input.idempotencyKey), walletLinkRef: text(input.walletLinkRef),
          runtimeGeneration: safeInteger(input.runtimeGeneration), sessionRevision: safeInteger(input.sessionRevision),
        }) as unknown as Readonly<Record<string, unknown>>;
        break;
      }
      case "wallet.link.proof": {
        if (!services.receiptReview) return failure(operation, logger, PUBLIC_HTTP_FAILURES.runtime);
        const input = strictObject(body, ["idempotencyKey", "walletLinkRef", "challengeRef", "proof"]);
        payload = await services.receiptReview.consumeProof(serviceCredential(cookies), {
          idempotencyKey: text(input.idempotencyKey), walletLinkRef: text(input.walletLinkRef),
          challengeRef: text(input.challengeRef), proof: proof(input.proof) as unknown as Parameters<ReceiptReviewWalletAuthority["consumeProof"]>[1]["proof"],
        }) as unknown as Readonly<Record<string, unknown>>;
        break;
      }
      case "wallet.link.disconnect": {
        if (!services.receiptReview) return failure(operation, logger, PUBLIC_HTTP_FAILURES.runtime);
        const input = strictObject(body, ["idempotencyKey", "walletLinkRef", "runtimeGeneration", "sessionRevision"]);
        payload = await services.receiptReview.disconnect(serviceCredential(cookies), {
          idempotencyKey: text(input.idempotencyKey), walletLinkRef: text(input.walletLinkRef),
          runtimeGeneration: safeInteger(input.runtimeGeneration), sessionRevision: safeInteger(input.sessionRevision),
        }) as unknown as Readonly<Record<string, unknown>>;
        break;
      }
      case "receipt.review.prepare": {
        if (!services.receiptReview) return failure(operation, logger, PUBLIC_HTTP_FAILURES.runtime);
        const input = strictObject(body, ["idempotencyKey", "walletLinkRef", "runtimeGeneration", "sessionRevision"]);
        payload = { projection: await services.receiptReview.prepareReview(serviceCredential(cookies), {
          idempotencyKey: text(input.idempotencyKey), walletLinkRef: text(input.walletLinkRef),
          runtimeGeneration: safeInteger(input.runtimeGeneration), sessionRevision: safeInteger(input.sessionRevision),
        }) };
        break;
      }
      case "receipt.review.restore": {
        if (!services.receiptReview) return failure(operation, logger, PUBLIC_HTTP_FAILURES.runtime);
        exactEmpty(body);
        payload = await services.receiptReview.restoreReviewState(serviceCredential(cookies));
        break;
      }
      case "receipt.review.preflight": {
        if (!services.receiptReview) return failure(operation, logger, PUBLIC_HTTP_FAILURES.runtime);
        const input = strictObject(body, ["idempotencyKey", "walletLinkRef", "runtimeGeneration", "sessionRevision",
          "publicIntentRef", "expectedProjectionRevision", "reviewDigest"]);
        payload = await services.receiptReview.preflight(serviceCredential(cookies), {
          idempotencyKey: text(input.idempotencyKey), walletLinkRef: text(input.walletLinkRef),
          runtimeGeneration: safeInteger(input.runtimeGeneration), sessionRevision: safeInteger(input.sessionRevision),
          publicIntentRef: text(input.publicIntentRef), expectedProjectionRevision: text(input.expectedProjectionRevision),
          reviewDigest: text(input.reviewDigest),
        }) as unknown as Readonly<Record<string, unknown>>;
        break;
      }
    }
    emit(logger, { event: "account_http_completed", operation, resultCode: "OK" });
    return response(200, payload, outgoing);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return failure(operation, logger, { status: 413, body: PUBLIC_HTTP_FAILURES.request.body });
    }
    if ((operation === "service.query" || operation === "service.command")
      && errorCode(error) === "GUEST_ROTATION_REQUIRED") {
      return refreshGuestServiceCredential(operation, request, services, logger);
    }
    if ((operation === "service.query" || operation === "service.command")
      && (error instanceof ServiceAuthorityCookieError || error instanceof CookieRejectedError
        || error instanceof CommandAuthenticationError || errorCode(error) === "COMMAND_AUTHENTICATION_FAILED")) {
      return failure(operation, logger, PUBLIC_HTTP_FAILURES.serviceAuthentication);
    }
    if (error instanceof StrictJsonError || error instanceof CookieRejectedError) {
      return failure(operation, logger, PUBLIC_HTTP_FAILURES.request);
    }
    if (error instanceof GuestRotationDeferredError) {
      return failure(operation, logger, { status: 409, body: { code: "GUEST_ROTATION_DEFERRED", message: "Guest rotation is temporarily deferred." } });
    }
    if (errorCode(error)?.includes("NOT_FOUND")) return failure(operation, logger, PUBLIC_HTTP_FAILURES.notFound);
    const category = operation.startsWith("guest.")
      ? PUBLIC_HTTP_FAILURES.guest
      : operation.startsWith("service.") ? PUBLIC_HTTP_FAILURES.service
        : operation.startsWith("wallet.") ? PUBLIC_HTTP_FAILURES.wallet
          : operation.startsWith("receipt.") ? PUBLIC_HTTP_FAILURES.review : PUBLIC_HTTP_FAILURES.request;
    return failure(operation, logger, category);
  }
}

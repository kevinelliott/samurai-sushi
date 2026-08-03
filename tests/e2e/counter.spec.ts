import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import {
  buildBrowserEveningServiceView,
  compiledFirstEveningService,
  type BrowserEveningServiceView,
} from "../../packages/content/src/index";
import {
  createCommandEnvelope,
} from "../../packages/domain/src/commands";
import {
  createInitialEveningServiceCheckpoint,
  FIRST_EVENING_CONTENT_VERSION,
  projectEveningService,
  reduceEveningService,
  type EveningServiceCheckpoint,
} from "../../packages/domain/src/evening-service";
import { FIRST_SERVICE_BROWSER_INVENTORY } from "../../apps/web/app/service-browser-inventory.generated";
import { notReady } from "../../packages/wallet-link/src/preflight";
import { WALLET_REVIEW_COPY } from "../../packages/wallet-link/src/presentation";
import { GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY, RECEIPT_STATUS_PRESENTATION } from "../../packages/receipt-lifecycle/src/review-projection";

const subject = { kind: "guest", guestSessionId: "browser-fixture-guest-0001" } as const;
type PublicCommand = { readonly idempotencyKey: string; readonly expectedRevision: number; readonly commandName: string; readonly payload: Readonly<Record<string, unknown>> };

function viewFor(
  checkpoint: EveningServiceCheckpoint,
  disposition: "query" | "committed" | "replayed" | "restored" = "query",
  correctiveCueId: string | null = null,
  identity: "guest" | "player" = "guest",
): BrowserEveningServiceView {
  return buildBrowserEveningServiceView(checkpoint,
    projectEveningService(checkpoint, compiledFirstEveningService.projectionManifest, { disposition, correctiveCueId }), identity);
}

interface RouteFixture {
  readonly install: (page: Page) => Promise<void>;
  readonly bodies: string[];
  readonly requests: string[];
  readonly setDropNextAfterCommit: () => void;
  readonly setUnavailable: (value: boolean) => void;
  readonly setAuthorityRejected: (value: boolean) => void;
  readonly setWrongAuthorityResponse: (value: boolean) => void;
  readonly setCredentialRefreshNext: () => void;
  readonly setMalformedNextQuery: () => void;
  readonly setConflictNextQuery: () => void;
  readonly setIdentity: (identity: "guest" | "player") => void;
  readonly revokeReviewCredential: () => void;
  readonly holdNextQuery: () => { readonly release: () => void; readonly started: Promise<void> };
  readonly holdNextCommand: () => { readonly release: () => void; readonly started: Promise<void> };
  readonly holdNextReview: (path: string) => { readonly release: () => void; readonly started: Promise<void> };
  readonly setPreflightReason: (reason: string | null) => void;
  readonly checkpoint: () => EveningServiceCheckpoint;
}

function reviewedProjection(): Record<string, unknown> {
  const account = "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6";
  return {
    schemaVersion: 1, projectionRevision: "1",
    intent: { intentRef: "ri_AAAAAAAAAAAAAAAAAAAAAA", state: "REVIEWED",
      createdAt: "2026-08-02T12:00:00.000Z", expiresAt: "2026-08-03T12:15:00.000Z" },
    status: { displayState: "REVIEWED", ...RECEIPT_STATUS_PRESENTATION.REVIEWED },
    reviewFacts: { domain: "SAMURAI_SUSHI_RECEIPT_V1", payloadSchemaVersion: 1,
      network: GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY[0], owner: account, source: account,
      destination: `KT1${"1".repeat(33)}`, entrypoint: "submit_receipt", attachedMutez: "0",
      serviceCommitment: "11".repeat(32), contentVersion: FIRST_EVENING_CONTENT_VERSION, nonce: "22".repeat(32),
      issuedAt: "2026-08-02T12:00:00.000Z", expiry: "2026-08-03T12:15:00.000Z",
      issuerKeyId: "localnet-issuer-v1", issuerPolicyVersion: "localnet-policy-v1",
      packedPayloadHex: "0501", payloadHash: "33".repeat(32) },
    policy: { confirmationThreshold: "2", finalityPolicyRef: "localnet-two-confirmation-rehearsal-v1" },
    activeAttempt: null, canonicalReceipt: null, incident: null,
  };
}

function serviceFixture(initial = createInitialEveningServiceCheckpoint(), initialActiveReview = false): RouteFixture {
  let activeReview = initialActiveReview;
  let checkpoint = initial;
  let dropNextAfterCommit = false;
  let unavailable = false;
  let authorityRejected = false;
  let wrongAuthorityResponse = false;
  let credentialRefreshNext = false;
  let malformedNextQuery = false;
  let conflictNextQuery = false;
  let identity: "guest" | "player" = activeReview ? "player" : "guest";
  let preparedReview: Record<string, unknown> | null = null;
  let currentWalletAccess: Record<string, unknown> | null = null;
  let heldQuery: { readonly started: () => void; readonly wait: Promise<void>; readonly release: () => void } | null = null;
  let heldCommand: { readonly started: () => void; readonly wait: Promise<void>; readonly release: () => void } | null = null;
  const heldReviews = new Map<string, { readonly started: () => void; readonly wait: Promise<void>; readonly release: () => void }>();
  let preflightReason: string | null = null;
  const receipts = new Map<string, { readonly body: string; readonly checkpoint: EveningServiceCheckpoint; readonly cue: string | null }>();
  const bodies: string[] = [];
  const requests: string[] = [];

  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  const handle = async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const heldReview = heldReviews.get(path);
    if (heldReview) { heldReviews.delete(path); heldReview.started(); await heldReview.wait; }
    if (path === "/api/account/cookies/reset") return json(route, 200, { reset: true });
    if (path === "/api/account/guest/issue") {
      checkpoint = createInitialEveningServiceCheckpoint();
      identity = "guest";
      authorityRejected = false;
      return json(route, 200, { issued: true });
    }
    if (path === "/api/account/receipt/review/restore") return json(route, 200, { schemaVersion: 1, doorway: {
      schemaVersion: 1, network: { profile: "localnet", chainId: "NetXtJqPyJGB6Pc",
        networkLabelRef: "network.localnet-rehearsal", label: "Localnet rehearsal",
        manifestVerificationRef: "manifest.registered-verified", manifestVerification: "Registered manifest verified" },
      effect: "This optional review can prepare one non-transferable service receipt for the displayed account. It does not change your saved service, unlock anything, or create a financial asset.",
      access: "Connecting asks the wallet for account access on the required network. This phase does not request a signature, estimate a fee, call a contract, or send an operation.",
      actionLabel: "Connect wallet for Localnet rehearsal",
    }, accessPresentation: currentWalletAccess?.state === "ACCOUNT_PROOF_UNAVAILABLE"
      ? WALLET_REVIEW_COPY["wallet.access.account-proof-unavailable"]
      : preparedReview ? WALLET_REVIEW_COPY["wallet.access.disconnected"] : WALLET_REVIEW_COPY["wallet.access.required"],
    projection: preparedReview, walletAccess: currentWalletAccess });
    if (path === "/api/account/wallet/runtime/sync") {
      const request = JSON.parse(route.request().postData() ?? "{}") as { runtimeGeneration?: number; runtime?: { providerId?: string; chainId?: string; account?: string } };
      if (identity === "guest") return json(route, 200, { schemaVersion: 1, accessScope: "DISPLAY_ONLY", state: "ACCOUNT_PROOF_UNAVAILABLE",
        providerId: request.runtime?.providerId, chainId: request.runtime?.chainId, account: request.runtime?.account,
        permissionScopes: ["account"], credentialMatch: false, reason: "ACCOUNT_PROOF_UNAVAILABLE",
        presentation: WALLET_REVIEW_COPY["wallet.access.account-proof-unavailable"] });
      currentWalletAccess = { schemaVersion: 1, walletLinkRef: "wl_AAAAAAAAAAAAAAAAAAAAAA", state: activeReview ? "ACTIVE_CREDENTIAL_MATCH" : "ACCOUNT_PROOF_UNAVAILABLE",
        runtimeGeneration: request.runtimeGeneration, sessionRevision: 1, providerId: request.runtime?.providerId,
        chainId: request.runtime?.chainId, account: request.runtime?.account, permissionScopes: ["account"], credentialMatch: activeReview,
        reason: activeReview ? null : "ACCOUNT_PROOF_UNAVAILABLE", presentation: activeReview
          ? WALLET_REVIEW_COPY["wallet.access.connected"] : WALLET_REVIEW_COPY["wallet.access.account-proof-unavailable"] };
      return json(route, 200, currentWalletAccess);
    }
    if (activeReview && path === "/api/account/receipt/review/prepare") {
      preparedReview ??= reviewedProjection();
      return json(route, 200, { schemaVersion: 1, projection: preparedReview });
    }
    if (activeReview && path === "/api/account/receipt/review/preflight") {
      const request = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      if (preflightReason) {
        return json(route, 200, notReady(preflightReason as Parameters<typeof notReady>[0]));
      }
      return json(route, 200, { schemaVersion: 1, status: "REVIEW_READY", intentRef: request.publicIntentRef,
        projectionRevision: request.expectedProjectionRevision, walletLinkRef: request.walletLinkRef,
        runtimeGeneration: request.runtimeGeneration, sessionRevision: request.sessionRevision,
        reviewDigest: request.reviewDigest, expiresAt: "2026-08-03T12:15:00.000Z",
        presentation: WALLET_REVIEW_COPY["receipt.preflight.ready"] });
    }
    if (activeReview && path === "/api/account/wallet/link/disconnect") {
      currentWalletAccess = null;
      return json(route, 200, { schemaVersion: 1, walletLinkRef: "wl_AAAAAAAAAAAAAAAAAAAAAA", state: "DISCONNECTED",
        runtimeGeneration: 2, sessionRevision: 2, providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc",
        account: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6", permissionScopes: ["account"], credentialMatch: false,
        reason: "DISCONNECTED", presentation: WALLET_REVIEW_COPY["wallet.access.disconnected"] });
    }
    if (path.startsWith("/api/account/receipt/review/") || path.startsWith("/api/account/wallet/")) {
      return json(route, 409, { code: "RECEIPT_REVIEW_REJECTED", message: "The optional receipt review could not be prepared." });
    }
    if (path !== "/api/account/service" && path !== "/api/account/service/command") return route.continue();
    if (unavailable) {
      if (path === "/api/account/service/command") bodies.push(route.request().postData() ?? "");
      return json(route, 503, { code: "SERVICE_UNAVAILABLE", message: "hostile-runtime-marker" });
    }
    if (authorityRejected) return json(route, 401, { code: "SERVICE_AUTHORITY_REJECTED", message: "Service access could not be authenticated." });
    if (wrongAuthorityResponse) return json(route, 401, { code: "REQUEST_REJECTED", message: "The request could not be processed." });
    if (credentialRefreshNext) {
      credentialRefreshNext = false;
      if (path === "/api/account/service/command") bodies.push(route.request().postData() ?? "");
      return json(route, 428, { code: "SERVICE_CREDENTIAL_REFRESHED", message: "Service access was refreshed. Requery the saved service." });
    }
    if (path === "/api/account/service") {
      if (conflictNextQuery) {
        conflictNextQuery = false;
        return json(route, 409, { code: "SERVICE_REQUEST_REJECTED", message: "The saved service could not be updated." });
      }
      const snapshot: { view: BrowserEveningServiceView | Record<string, unknown> } = { view: viewFor(checkpoint, "query", null, identity) };
      if (malformedNextQuery) {
        malformedNextQuery = false;
        const mutated = JSON.parse(JSON.stringify(snapshot.view)) as Record<string, unknown>;
        const choices = mutated.choices as Record<string, unknown>[];
        choices[0] = { ...choices[0], id: "season", payload: { beat: "season" } };
        snapshot.view = mutated;
      }
      const held = heldQuery;
      if (held) { heldQuery = null; held.started(); await held.wait; }
      return json(route, 200, snapshot);
    }

    const body = route.request().postData() ?? "";
    bodies.push(body);
    const pending = heldCommand;
    if (pending) { heldCommand = null; pending.started(); await pending.wait; }
    let parsed: PublicCommand;
    try { parsed = JSON.parse(body) as PublicCommand; } catch { return json(route, 400, { code: "REQUEST_REJECTED" }); }
    const stored = receipts.get(parsed.idempotencyKey);
    if (stored) {
      if (stored.body !== body) return json(route, 409, { code: "SERVICE_REQUEST_REJECTED" });
      return json(route, 200, { view: viewFor(stored.checkpoint, "replayed", stored.cue, identity) });
    }
    if (parsed.expectedRevision !== checkpoint.revision) return json(route, 409, { code: "SERVICE_REQUEST_REJECTED" });
    const decision = reduceEveningService(checkpoint, createCommandEnvelope({ schemaVersion: 1, contentVersion: FIRST_EVENING_CONTENT_VERSION,
      commandName: parsed.commandName, subject, idempotencyKey: parsed.idempotencyKey as never,
      expectedRevision: parsed.expectedRevision, payload: parsed.payload }));
    checkpoint = decision.checkpoint;
    const cue = decision.response.payload.correctiveCueId;
    receipts.set(parsed.idempotencyKey, { body, checkpoint, cue });
    if (dropNextAfterCommit) {
      dropNextAfterCommit = false;
      return route.abort("failed");
    }
    return json(route, 200, { view: viewFor(checkpoint, "committed", cue, identity) });
  };
  return {
    install: (page) => page.route("**/api/account/**", handle), bodies, requests,
    setDropNextAfterCommit: () => { dropNextAfterCommit = true; },
    setUnavailable: (value) => { unavailable = value; },
    setAuthorityRejected: (value) => { authorityRejected = value; },
    setWrongAuthorityResponse: (value) => { wrongAuthorityResponse = value; },
    setCredentialRefreshNext: () => { credentialRefreshNext = true; },
    setMalformedNextQuery: () => { malformedNextQuery = true; },
    setConflictNextQuery: () => { conflictNextQuery = true; },
    setIdentity: (value) => { identity = value; },
    revokeReviewCredential: () => { activeReview = false; currentWalletAccess = null; },
    holdNextQuery: () => {
      let release!: () => void;
      let started!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      heldQuery = { started, wait, release };
      return { release, started: startedPromise };
    },
    holdNextCommand: () => {
      let release!: () => void;
      let started!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      heldCommand = { started, wait, release };
      return { release, started: startedPromise };
    },
    holdNextReview: (path) => {
      let release!: () => void; let started!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      heldReviews.set(path, { started, wait, release }); return { release, started: startedPromise };
    },
    setPreflightReason: (reason) => { preflightReason = reason; },
    checkpoint: () => checkpoint,
  };
}

async function interdictPersistence(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const reject = () => { throw new Error("browser persistence is forbidden"); };
    for (const method of ["getItem", "setItem", "removeItem", "clear", "key"] as const) {
      Object.defineProperty(Storage.prototype, method, { configurable: true, value: reject });
    }
    Object.defineProperty(IDBFactory.prototype, "open", { configurable: true, value: reject });
    Object.defineProperty(IDBFactory.prototype, "deleteDatabase", { configurable: true, value: reject });
    if ("caches" in window) for (const method of ["open", "delete", "keys", "match"] as const) {
      Object.defineProperty(CacheStorage.prototype, method, { configurable: true, value: reject });
    }
    if ("serviceWorker" in navigator) Object.defineProperty(ServiceWorkerContainer.prototype, "register", { configurable: true, value: reject });
  });
}

async function forceAnimationFrameBeforeReactCommit(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => { callback(performance.now()); return 1; },
    });
  });
}

const EXPECTED_REVIEW_RUNTIME = Object.freeze({ providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc",
  account: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6", permissionScopes: ["account"] as const });
type ReviewFetchBoundary = "headers" | "body";

async function installControlledReviewBrowser(page: Page): Promise<void> {
  await page.addInitScript((expected) => {
    type Gate = { armed: number; started: number; resolvers: (() => void)[] };
    const fetchGates = new Map<string, Gate>();
    const gate = (path: string, boundary: string) => {
      const key = `${path}:${boundary}`; const found = fetchGates.get(key) ?? { armed: 0, started: 0, resolvers: [] };
      fetchGates.set(key, found); return found;
    };
    const wait = async (path: string, boundary: string) => {
      const current = gate(path, boundary); if (current.armed < 1) return;
      current.armed -= 1; current.started += 1; await new Promise<void>((resolve) => { current.resolvers.push(resolve); });
    };
    const importGate = { armed: 0, started: 0, resolvers: [] as (() => void)[] };
    const state = { mode: "PERMISSIONED", runtime: expected, permissionResolvers: [] as ((value: unknown) => void)[],
      activeListeners: [] as ((value: unknown) => void)[], listenerHistory: [] as ((value: unknown) => void)[], fetchGates };
    const counters = { permission: 0, read: 0, disconnect: 0, subscribe: 0, unsubscribe: 0,
      sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 };
    Object.defineProperty(window, "__reviewBarrierState", { value: state });
    Object.defineProperty(window, "__walletTripwires", { value: counters });
    Object.defineProperty(window, "__samuraiReceiptReviewTestBarrier", { value: async (name: number) => {
      if (name !== 1 || importGate.armed < 1) return;
      importGate.armed -= 1; importGate.started += 1; await new Promise<void>((resolve) => { importGate.resolvers.push(resolve); });
    } });
    Object.defineProperty(window, "samuraiLocalnetWallet", { value: {
      requestPermission: async () => { counters.permission += 1;
        if (state.mode === "DEFER") return new Promise((resolve) => { state.permissionResolvers.push(resolve); });
        return state.mode === "PERMISSIONED" ? state.runtime : { status: state.mode }; },
      readRuntime: async () => { counters.read += 1; return state.runtime; },
      subscribe: (listener: (value: unknown) => void) => { counters.subscribe += 1; state.activeListeners.push(listener); state.listenerHistory.push(listener);
        return () => { counters.unsubscribe += 1; state.activeListeners = state.activeListeners.filter((item) => item !== listener); }; },
      disconnect: async () => { counters.disconnect += 1; },
    } });
    const originalFetch = window.fetch.bind(window);
    Object.defineProperty(window, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname;
      const response = await originalFetch(input, init); await wait(path, "headers");
      return new Proxy(response, { get(target, property) {
        if (property === "json") return async () => { await wait(path, "body"); return target.json(); };
        const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    } });
    Object.defineProperty(window, "__reviewBarrierControl", { value: {
      arm: (path: string, boundary: string) => { gate(path, boundary).armed += 1; },
      started: (path: string, boundary: string) => gate(path, boundary).started,
      release: (path: string, boundary: string) => { gate(path, boundary).resolvers.shift()?.(); },
      armImport: () => { importGate.armed += 1; }, startedImport: () => importGate.started,
      releaseImport: () => { importGate.resolvers.shift()?.(); },
    } });
  }, EXPECTED_REVIEW_RUNTIME);
}

async function armReviewFetchBarrier(page: Page, path: string, boundary: ReviewFetchBoundary): Promise<Readonly<{
  started: () => Promise<void>; release: () => Promise<void> }>> {
  await page.evaluate(({ path: target, boundary: point }) => {
    (window as unknown as { __reviewBarrierControl: { arm(path: string, boundary: string): void } }).__reviewBarrierControl.arm(target, point);
  }, { path, boundary });
  return {
    started: () => expect.poll(() => page.evaluate(({ path: target, boundary: point }) =>
      (window as unknown as { __reviewBarrierControl: { started(path: string, boundary: string): number } }).__reviewBarrierControl.started(target, point),
    { path, boundary })).toBeGreaterThan(0),
    release: () => page.evaluate(({ path: target, boundary: point }) =>
      (window as unknown as { __reviewBarrierControl: { release(path: string, boundary: string): void } }).__reviewBarrierControl.release(target, point),
    { path, boundary }),
  };
}

async function reviewTripwires(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...(window as unknown as { __walletTripwires: Record<string, number> }).__walletTripwires }));
}

async function performProjectedChoice(page: Page, command: PublicCommand): Promise<void> {
  const checked = page.getByRole("radio", { checked: true });
  const all = page.getByRole("radio");
  if (await all.count() > 1) {
    const value = String(command.payload.beat ?? command.payload.stepId ?? command.payload.choice ?? command.payload.orderId);
    await page.locator(`input[type="radio"][value="${value}"]`).check();
  } else {
    await expect(checked).toHaveCount(1);
  }
  await page.locator(".perform-action .primary-action").click();
}

test("projection-only first service completes with exact commands and one-shot ceremony", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "complete journey is covered once; mobile receives the responsive matrix");
  const fixture = serviceFixture();
  await fixture.install(page);
  await interdictPersistence(page);
  await page.addInitScript(() => {
    const counters = { permission: 0, read: 0, disconnect: 0, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 };
    Object.defineProperty(window, "__walletTripwires", { configurable: false, value: counters });
    Object.defineProperty(window, "samuraiLocalnetWallet", { configurable: false, value: {
      requestPermission: async () => { counters.permission += 1; return { providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc", account: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6", permissionScopes: ["account"] }; },
      readRuntime: async () => { counters.read += 1; throw new Error("not requested"); },
      subscribe: () => () => undefined,
      disconnect: async () => { counters.disconnect += 1; },
    } });
  });
  const diagnostics: string[] = [];
  page.on("console", (message) => diagnostics.push(message.text()));
  page.on("pageerror", (error) => diagnostics.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  await expect(page.getByRole("button", { name: /review optional keepsake/i })).toHaveCount(0);

  const replay = compiledFirstEveningService.goldenReplay.slice(1) as readonly { readonly command: PublicCommand; readonly response: { readonly checkpoint: EveningServiceCheckpoint } }[];
  for (const [index, item] of replay.entries()) {
    const before = viewFor(fixture.checkpoint());
    await performProjectedChoice(page, item.command);
    const actualBody = fixture.bodies[index]!;
    const parsedBody = JSON.parse(actualBody) as PublicCommand;
    expect(parsedBody.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect({ ...parsedBody, idempotencyKey: "<intent>" }).toEqual({
      idempotencyKey: "<intent>", expectedRevision: item.command.expectedRevision,
      commandName: item.command.commandName, payload: item.command.payload,
    });
    expect(actualBody).toBe(JSON.stringify({ idempotencyKey: parsedBody.idempotencyKey,
      expectedRevision: item.command.expectedRevision, commandName: item.command.commandName, payload: item.command.payload }));
    if (item.command.commandName === "service.serve-order") {
      const expected = viewFor(item.response.checkpoint, "committed").ledgerRows.at(-1)!;
      await expect(page.getByRole("heading", { name: expected.outcome.text })).toBeFocused();
      await expect(page.locator(".serve-ceremony").getByText(expected.serveFeedback.text, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Next order" }).click();
    } else if (!(["SETTLED", "ABANDONED"] as string[]).includes(item.response.checkpoint.phase)) {
      await expect(page.getByRole("heading", { name: viewFor(item.response.checkpoint).prompt.text })).toBeVisible();
    }
    expect(fixture.checkpoint().revision).toBe(before.revision + 1);
  }
  await expect(page.getByText("Service settled", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved cosmetic restoration", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review optional keepsake" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __walletTripwires: { permission: number } }).__walletTripwires.permission)).toBe(0);
  await page.getByRole("button", { name: "Review optional keepsake" }).click();
  await expect(page.getByRole("heading", { name: "Review optional service keepsake" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Connect wallet for Localnet rehearsal" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __walletTripwires: { permission: number } }).__walletTripwires.permission)).toBe(0);
  await page.getByRole("button", { name: "Connect wallet for Localnet rehearsal" }).click();
  await expect(page.getByRole("heading", { name: "Verified account proof unavailable" })).toBeFocused();
  await expect(page.getByRole("button", { name: /connect|reconnect/iu })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
  const tripwires = await page.evaluate(() => (window as unknown as { __walletTripwires: Record<string, number> }).__walletTripwires);
  expect(tripwires).toEqual({ permission: 1, read: 0, disconnect: 0, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 });
  expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/prepare")).toEqual([]);
  expect(fixture.requests.filter((path) => path === "/api/account/wallet/link/disconnect")).toEqual([]);
  expect(new Set(fixture.bodies.map((body) => JSON.parse(body).idempotencyKey)).size).toBe(29);
  const renderedText = await page.locator("body").innerText();
  for (const body of fixture.bodies) expect(renderedText).not.toContain((JSON.parse(body) as PublicCommand).idempotencyKey);
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("button", { name: "Review optional keepsake" })).toBeFocused();
  expect((await reviewTripwires(page)).permission).toBe(1);
  expect(diagnostics.join("\n")).not.toMatch(/hostile|cookie|subject|checkpoint|signature|proof|database|digest|hmac/iu);
});

test("@receipt-review a settled player without an active credential receives the stable proof-unavailable outcome", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the unmatched durable player path is exercised once");
  const settled = (compiledFirstEveningService.goldenReplay.at(-1) as {
    readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const fixture = serviceFixture(settled, false); fixture.setIdentity("player"); await fixture.install(page);
  await page.addInitScript((runtime) => {
    const counters = { permission: 0, read: 0, disconnect: 0, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 };
    Object.defineProperty(window, "__walletTripwires", { value: counters });
    Object.defineProperty(window, "samuraiLocalnetWallet", { value: {
      requestPermission: async () => { counters.permission += 1; return runtime; }, readRuntime: async () => { counters.read += 1; return runtime; },
      subscribe: () => () => undefined, disconnect: async () => { counters.disconnect += 1; },
    } });
  }, EXPECTED_REVIEW_RUNTIME);
  await page.goto("/"); await page.getByRole("button", { name: "Review optional keepsake" }).click();
  await page.getByRole("button", { name: "Connect wallet for Localnet rehearsal" }).click();
  await expect(page.getByRole("heading", { name: "Verified account proof unavailable" })).toBeFocused();
  await expect(page.getByText("The wallet reported an account, but this phase cannot request the proof needed to verify it.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect|reconnect/iu })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Not now" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Review optional keepsake" })).toBeFocused();
  expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/prepare")).toEqual([]);
  expect(await reviewTripwires(page)).toMatchObject({ permission: 1, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 });
});

test("@receipt-review settled optional review keeps gameplay primary and renders exact access and review stages", async ({ page }, testInfo) => {
  const settled = (compiledFirstEveningService.goldenReplay.at(-1) as {
    readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const fixture = serviceFixture(settled, true);
  const activate = async (locator: Locator) => { if (testInfo.project.name === "review-zoom-200") { await locator.focus(); await locator.press("Enter"); }
    else await locator.click(); };
  await fixture.install(page);
  await page.addInitScript(() => {
    const runtime = { providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc",
      account: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6", permissionScopes: ["account"] };
    const counters = { permission: 0, read: 0, disconnect: 0, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 };
    Object.defineProperty(window, "__walletTripwires", { configurable: false, value: counters });
    Object.defineProperty(window, "samuraiLocalnetWallet", { configurable: false, value: {
      requestPermission: async () => { counters.permission += 1; return runtime; },
      readRuntime: async () => { counters.read += 1; return runtime; },
      subscribe: () => () => undefined,
      disconnect: async () => { counters.disconnect += 1; },
    } });
  });
  await page.goto("/");
  const assertEffectiveZoomReflow = async (targets: readonly Locator[]) => {
    if (testInfo.project.name !== "review-zoom-200") return;
    const geometry = await page.evaluate(() => {
      const dialog = document.querySelector("dialog"); if (!(dialog instanceof HTMLDialogElement)) throw new Error("dialog");
      const dialogRect = dialog.getBoundingClientRect();
      const horizontallyClipped = [...dialog.querySelectorAll("*")].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.left < dialogRect.left - 1 || rect.right > dialogRect.right + 1);
      }).map((element) => element.tagName);
      return { innerWidth, visualWidth: visualViewport?.width ?? innerWidth, devicePixelRatio,
        documentWidth: document.documentElement.scrollWidth, documentClientWidth: document.documentElement.clientWidth,
        dialogWidth: dialog.scrollWidth, dialogClientWidth: dialog.clientWidth,
        dialogScrollHeight: dialog.scrollHeight, dialogClientHeight: dialog.clientHeight,
        frameWidth: dialog.firstElementChild?.scrollWidth ?? 0, frameClientWidth: dialog.firstElementChild?.clientWidth ?? 0,
        horizontallyClipped };
    });
    expect(geometry).toMatchObject({ innerWidth: 320, visualWidth: 320, devicePixelRatio: 2, horizontallyClipped: [] });
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.documentClientWidth);
    expect(geometry.dialogWidth).toBeLessThanOrEqual(geometry.dialogClientWidth);
    expect(geometry.frameWidth).toBeLessThanOrEqual(geometry.frameClientWidth);
    expect(geometry.dialogScrollHeight).toBeGreaterThan(geometry.dialogClientHeight);
    for (const target of targets) {
      await expect(target).toBeVisible(); await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox(); expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
    await page.locator(".review-dialog-frame").evaluate((frame) => { frame.scrollTop = 0; });
    await page.locator("dialog").evaluate((dialog) => { dialog.scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, 0));
    const title = page.getByRole("heading", { name: "Review optional service keepsake" }); await expect(title).toBeVisible();
    const titleBox = await title.boundingBox(); expect(titleBox).not.toBeNull(); expect(titleBox!.y).toBeGreaterThanOrEqual(0);
    expect(titleBox!.y + titleBox!.height).toBeLessThanOrEqual(720);
  };
  await expect(page.getByRole("button", { name: "Keep playing" })).toHaveClass(/primary-action/);
  const invoker = page.getByRole("button", { name: "Review optional keepsake" });
  await invoker.click();
  await expect(page.getByRole("heading", { name: "Review optional service keepsake" })).toBeFocused();
  await expect(page.getByText("Localnet rehearsal · non-production · no real value", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect wallet for Localnet rehearsal" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth,
    dialog: document.querySelector("dialog")?.scrollWidth ?? 0, dialogClient: document.querySelector("dialog")?.clientWidth ?? 0 }));
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.dialog).toBeLessThanOrEqual(dimensions.dialogClient);
  await assertEffectiveZoomReflow([page.getByText("Optional · non-transferable · no financial value", { exact: true }), page.getByRole("heading", { name: "Review optional service keepsake" }),
    page.getByText("This optional review can prepare one non-transferable service receipt", { exact: false }),
    page.locator("#wallet-access-title"), page.getByRole("button", { name: "Connect wallet for Localnet rehearsal" })]);
  await page.screenshot({ path: `.scratch/phase2c-review/access-${testInfo.project.name}.png`, fullPage: false });
  await activate(page.getByRole("button", { name: "Connect wallet for Localnet rehearsal" }));
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  await expect(page.getByText("Nothing has been sent.", { exact: false })).toBeVisible();
  await expect(page.getByText("Exact active credential match", { exact: true })).toBeVisible();
  await expect(page.getByText("0 mutez attached", { exact: true })).toBeVisible();
  await expect(page.getByText("Not estimated in this phase.", { exact: false })).toBeVisible();
  await assertEffectiveZoomReflow([page.getByText("Optional · non-transferable · no financial value", { exact: true }), page.getByRole("heading", { name: "Review optional service keepsake" }),
    page.getByRole("heading", { name: "Wallet connected for review" }), page.getByText("Exact active credential match", { exact: true }),
    page.getByText("Registered manifest verified", { exact: true }), page.getByText("0 mutez attached", { exact: true })]);
  await page.screenshot({ path: `.scratch/phase2c-review/review-${testInfo.project.name}.png`, fullPage: false });
  await activate(page.getByRole("button", { name: "Check review readiness" }));
  await expect(page.getByRole("heading", { name: "Review ready" })).toBeFocused();
  await expect(page.getByText("Exact current facts match.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /sign|send|submit|continue/i })).toHaveCount(0);
  const tripwires = await page.evaluate(() => (window as unknown as { __walletTripwires: Record<string, number> }).__walletTripwires);
  expect(tripwires).toEqual({ permission: 1, read: 1, disconnect: 0, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 });
  await activate(page.getByRole("button", { name: "Close review" }).first());
  await expect(invoker).toBeFocused();
  expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/prepare")).toHaveLength(1);
  expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/preflight")).toHaveLength(1);
  await page.reload();
  await activate(page.getByRole("button", { name: "Review optional keepsake" }));
  await expect(page.getByText("Wallet disconnected. The receipt details remain read-only.", { exact: true })).toBeVisible();
  await activate(page.getByRole("button", { name: "Reconnect matching wallet" }));
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  await expect(page.getByText("Exact active credential match", { exact: true })).toBeVisible();
  expect(fixture.requests.filter((path) => path === "/api/account/wallet/link/disconnect")).toHaveLength(1);
});

test("@receipt-review a prepared review honors the null recovery boundary after credential revocation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the prepared revocation recovery boundary is exercised once");
  const settled = (compiledFirstEveningService.goldenReplay.at(-1) as {
    readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const fixture = serviceFixture(settled, true); await fixture.install(page); await interdictPersistence(page);
  await page.addInitScript((runtime) => {
    const counters = { permission: 0, read: 0, disconnect: 0, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 };
    Object.defineProperty(window, "__walletTripwires", { value: counters });
    Object.defineProperty(window, "samuraiLocalnetWallet", { value: {
      requestPermission: async () => { counters.permission += 1; return runtime; },
      readRuntime: async () => { counters.read += 1; return runtime; },
      subscribe: () => () => undefined,
      disconnect: async () => { counters.disconnect += 1; },
    } });
  }, EXPECTED_REVIEW_RUNTIME);
  await page.goto("/");
  const invoker = page.getByRole("button", { name: "Review optional keepsake" });
  await invoker.click(); await page.getByRole("button", { name: "Connect wallet for Localnet rehearsal" }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  await expect(page.getByText("Nothing has been sent.", { exact: false })).toBeVisible();
  await expect(page.getByText("0 mutez attached", { exact: true })).toBeVisible();
  expect((await reviewTripwires(page)).permission).toBe(1);
  await page.getByRole("button", { name: "Close review" }).first().click();
  fixture.revokeReviewCredential();

  await page.reload(); await invoker.click();
  await expect(page.getByText("Wallet disconnected. The receipt details remain read-only.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reconnect matching wallet" }).click();
  await expect(page.getByRole("heading", { name: "Verified account proof unavailable" })).toBeFocused();
  await expect(page.getByText("Nothing has been sent.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Receipt account" })).toBeVisible();
  await expect(page.getByText("0 mutez attached", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect|reconnect/iu })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close review" }).last()).toBeVisible();
  expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/prepare")).toHaveLength(1);
  expect(fixture.requests.filter((path) => path === "/api/account/wallet/link/disconnect")).toEqual([]);
  expect(await reviewTripwires(page)).toEqual({ permission: 1, read: 0, disconnect: 0, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 });

  await page.getByRole("button", { name: "Close review" }).first().click();
  await expect(invoker).toBeFocused(); await invoker.click();
  await expect(page.getByRole("heading", { name: "Verified account proof unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect|reconnect/iu })).toHaveCount(0);
  expect((await reviewTripwires(page)).permission).toBe(1);
  expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/prepare")).toHaveLength(1);
});

for (const boundary of ["import", "permission"] as const) {
  test(`@receipt-review Stage B Not now closes a drifted reconnect at the deferred ${boundary} boundary`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the requesting dismissal boundaries are exercised once");
    const settled = (compiledFirstEveningService.goldenReplay.at(-1) as {
      readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
    const fixture = serviceFixture(settled, true); await fixture.install(page); await installControlledReviewBrowser(page); await page.goto("/");
    const invoker = page.getByRole("button", { name: "Review optional keepsake" }); await invoker.click();
    await page.getByRole("button", { name: "Connect wallet for Localnet rehearsal" }).click();
    await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
    await expect(page.getByText("Nothing has been sent.", { exact: false })).toBeVisible();
    await page.evaluate((runtime) => {
      const state = (window as unknown as { __reviewBarrierState: { activeListeners: ((value: unknown) => void)[] } }).__reviewBarrierState;
      for (const listener of [...state.activeListeners]) listener({ ...runtime, account: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb" });
    }, EXPECTED_REVIEW_RUNTIME);
    await expect(page.getByRole("heading", { name: "Wallet account changed" })).toBeFocused();
    if (boundary === "import") await page.evaluate(() => {
      (window as unknown as { __reviewBarrierControl: { armImport(): void } }).__reviewBarrierControl.armImport();
    });
    await page.evaluate(() => { (window as unknown as { __reviewBarrierState: { mode: string } }).__reviewBarrierState.mode = "DEFER"; });
    const before = await reviewTripwires(page);
    await page.getByRole("button", { name: "Reconnect matching wallet" }).click();
    if (boundary === "import") await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __reviewBarrierControl: { startedImport(): number } }).__reviewBarrierControl.startedImport())).toBe(1);
    else await expect.poll(() => reviewTripwires(page).then((value) => value.permission)).toBe(before.permission + 1);
    const atBarrierRequests = [...fixture.requests];
    await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
    await expect(page.getByRole("button", { name: /check review readiness|check again/iu })).toHaveCount(0);
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0); await expect(invoker).toBeFocused();
    if (boundary === "import") await page.evaluate(() => {
      (window as unknown as { __reviewBarrierControl: { releaseImport(): void } }).__reviewBarrierControl.releaseImport();
    });
    else await page.evaluate((runtime) => {
      const state = (window as unknown as { __reviewBarrierState: { permissionResolvers: ((value: unknown) => void)[] } }).__reviewBarrierState;
      state.permissionResolvers.shift()?.(runtime);
    }, EXPECTED_REVIEW_RUNTIME);
    await page.evaluate(() => Promise.resolve()); await expect(invoker).toBeFocused();
    const after = await reviewTripwires(page);
    expect(after.permission).toBe(before.permission + (boundary === "permission" ? 1 : 0));
    expect(after.subscribe).toBe(before.subscribe); expect(after.unsubscribe).toBe(before.unsubscribe);
    expect(fixture.requests).toEqual(atBarrierRequests);
    expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/preflight")).toHaveLength(0);
    expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/prepare")).toHaveLength(1);
    expect(after).toMatchObject({ sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 });
  });
}

test("@receipt-review distinct access, drift, preflight, keyboard, announcement, and retirement states stay fail closed", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the complete outcome and controlled-race matrix is exercised once");
  const settled = (compiledFirstEveningService.goldenReplay.at(-1) as {
    readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const fixture = serviceFixture(settled, true); await fixture.install(page);
  await page.addInitScript(() => {
    const expected = { providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc",
      account: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6", permissionScopes: ["account"] };
    const state = { mode: "PERMISSIONED", runtime: expected, listeners: [] as ((value: unknown) => void)[],
      permissionResolver: null as null | ((value: unknown) => void), holdDigest: false,
      digestStarted: 0, digestResolver: null as null | (() => void), holdClipboard: false,
      clipboardStarted: 0, clipboardResolver: null as null | (() => void) };
    const counters = { permission: 0, read: 0, disconnect: 0, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 };
    Object.defineProperty(window, "__walletTest", { value: state }); Object.defineProperty(window, "__walletTripwires", { value: counters });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {
      if (state.holdClipboard) { state.clipboardStarted += 1; await new Promise<void>((resolve) => { state.clipboardResolver = resolve; }); }
    } } });
    Object.defineProperty(window, "samuraiLocalnetWallet", { value: {
      requestPermission: async () => { counters.permission += 1; if (state.mode === "DEFER") return new Promise((resolve) => { state.permissionResolver = resolve; });
        return state.mode === "PERMISSIONED" ? state.runtime : { status: state.mode }; },
      readRuntime: async () => { counters.read += 1; return state.runtime; },
      subscribe: (listener: (value: unknown) => void) => { state.listeners.push(listener); return () => { state.listeners = state.listeners.filter((item) => item !== listener); }; },
      disconnect: async () => { counters.disconnect += 1; },
    } });
    const digest = SubtleCrypto.prototype.digest;
    Object.defineProperty(SubtleCrypto.prototype, "digest", { configurable: true, value: async function (...args: Parameters<SubtleCrypto["digest"]>) {
      if (state.holdDigest) { state.digestStarted += 1; await new Promise<void>((resolve) => { state.digestResolver = resolve; }); }
      return digest.apply(this, args);
    } });
  });
  const setMode = (mode: string, runtime?: Record<string, unknown>) => page.evaluate(({ mode: next, runtime: facts }) => {
    const state = (window as unknown as { __walletTest: { mode: string; runtime: unknown } }).__walletTest; state.mode = next; if (facts) state.runtime = facts;
  }, { mode, runtime });
  const invoker = page.getByRole("button", { name: "Review optional keepsake" });
  const openReview = async () => { await invoker.click();
    await expect(page.getByRole("heading", { name: "Review optional service keepsake" })).toBeFocused(); };
  await page.goto("/");
  for (const [mode, heading] of [["CANCELLED", "Wallet access cancelled"], ["REJECTED", "Wallet access declined"]] as const) {
    await setMode(mode); await openReview(); await page.getByRole("button", { name: /connect wallet|try connecting/i }).click();
    await expect(page.getByRole("heading", { name: heading })).toBeFocused(); await page.getByRole("button", { name: "Not now" }).click();
  }
  await setMode("PERMISSIONED", { providerId: "deterministic-wallet", chainId: "NetXsqzbfFenSTS",
    account: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6", permissionScopes: ["account"] });
  await openReview(); await page.getByRole("button", { name: /connect wallet/i }).click();
  await expect(page.getByRole("heading", { name: "Wallet network does not match" })).toBeFocused();
  expect(fixture.requests.filter((path) => path === "/api/account/wallet/runtime/sync")).toHaveLength(0);
  await page.getByRole("button", { name: "Not now" }).click();

  await setMode("PERMISSIONED", { providerId: "unknown-wallet", chainId: "NetXtJqPyJGB6Pc",
    account: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6", permissionScopes: ["account"], rawProviderError: "hostile" });
  await openReview(); await page.getByRole("button", { name: /connect wallet/i }).click();
  await expect(page.getByRole("heading", { name: "Wallet access unavailable" })).toBeFocused();
  await expect(page.getByText("Verified account proof unavailable", { exact: true })).toHaveCount(0);
  expect(fixture.requests.filter((path) => path === "/api/account/wallet/runtime/sync")).toHaveLength(0);
  expect(await page.locator("body").innerText()).not.toContain("hostile"); await page.getByRole("button", { name: "Not now" }).click();

  const expected = { providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc",
    account: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6", permissionScopes: ["account"] };
  await setMode("PERMISSIONED", expected); await openReview(); await page.getByRole("button", { name: /connect wallet/i }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  await page.evaluate(() => { (window as unknown as { __walletTest: { holdClipboard: boolean } }).__walletTest.holdClipboard = true; });
  await page.getByRole("button", { name: "Copy full chain id" }).first().click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __walletTest: { clipboardStarted: number } }).__walletTest.clipboardStarted)).toBe(1);
  await page.getByRole("button", { name: "Close review" }).first().click(); await openReview();
  await expect(page.getByText("Wallet disconnected. The receipt details remain read-only.", { exact: true })).toBeVisible();
  await page.evaluate(() => { const state = (window as unknown as { __walletTest: {
    holdClipboard: boolean; clipboardResolver: null | (() => void);
  } }).__walletTest; state.holdClipboard = false; state.clipboardResolver?.(); state.clipboardResolver = null; });
  await expect(page.getByRole("dialog").locator('[aria-live="polite"]')).not.toContainText("Chain ID copied.");
  await page.getByRole("button", { name: "Reconnect matching wallet" }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  await page.getByRole("button", { name: "Copy full chain id" }).first().click();
  await expect(page.getByRole("dialog").locator('[aria-live="polite"]')).toContainText("Chain ID copied.");
  const emit = (value: unknown) => page.evaluate((next) => { for (const listener of (window as unknown as { __walletTest: { listeners: ((item: unknown) => void)[] } }).__walletTest.listeners) listener(next); }, value);
  await emit({ ...expected, account: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb" });
  await expect(page.getByRole("heading", { name: "Wallet account changed" })).toBeFocused();
  await page.getByRole("button", { name: "Reconnect matching wallet" }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  await page.evaluate(() => { (window as unknown as { __walletTest: { holdDigest: boolean } }).__walletTest.holdDigest = true; });
  const preflightBeforeDigest = fixture.requests.filter((path) => path === "/api/account/receipt/review/preflight").length;
  await page.getByRole("button", { name: /check review readiness/i }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __walletTest: { digestStarted: number } }).__walletTest.digestStarted)).toBe(1);
  await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
  await expect(page.getByRole("button", { name: /checking|check review readiness|check again/iu })).toHaveCount(0);
  await page.getByRole("button", { name: "Not now" }).click();
  await page.evaluate(() => { const state = (window as unknown as { __walletTest: { holdDigest: boolean; digestResolver: null | (() => void) } }).__walletTest;
    state.holdDigest = false; state.digestResolver?.(); state.digestResolver = null; });
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(invoker).toBeFocused();
  expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/preflight")).toHaveLength(preflightBeforeDigest);
  await openReview(); await page.getByRole("button", { name: "Reconnect matching wallet" }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  const heldPreflight = fixture.holdNextReview("/api/account/receipt/review/preflight");
  await page.getByRole("button", { name: /check review readiness/i }).click(); await heldPreflight.started;
  const preflightAtBarrier = fixture.requests.filter((path) => path === "/api/account/receipt/review/preflight").length;
  await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click(); heldPreflight.release();
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(invoker).toBeFocused();
  expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/preflight")).toHaveLength(preflightAtBarrier);
  await openReview(); await page.getByRole("button", { name: "Reconnect matching wallet" }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  await emit({ status: "PERMISSION_CHANGED" }); await expect(page.getByRole("heading", { name: "Wallet permission changed" })).toBeFocused();
  await page.getByRole("button", { name: "Reconnect wallet" }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  await emit({ ...expected, providerId: "localnet-wallet" }); await expect(page.getByRole("heading", { name: "Wallet provider changed" })).toBeFocused();
  await page.getByRole("button", { name: "Reconnect matching wallet" }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  await emit({ status: "DISCONNECTED" }); await expect(page.getByRole("heading", { name: "Wallet disconnected" })).toBeFocused();
  await page.getByRole("button", { name: "Reconnect matching wallet" }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  for (const [reason, heading, reasonRef, recovery] of [
    ["AUTHENTICATION_REQUIRED", "Review sign-in changed", "receipt.preflight.authentication-required", "Close review"],
    ["SERVICE_NOT_SETTLED", "Service is not settled", "receipt.preflight.service-not-settled", "Close review"],
    ["NOT_FOUND", "Receipt review unavailable", "receipt.preflight.not-found", "Close review"],
    ["PROJECTION_STALE", "Receipt details changed", "receipt.preflight.projection-stale", "Review updated details"],
    ["INTENT_EXPIRED", "Receipt review expired", "receipt.preflight.intent-expired", "Prepare a fresh review"],
    ["WALLET_LINK_REQUIRED", "Matching wallet required", "receipt.preflight.wallet-link-required", "Reconnect matching wallet"],
    ["WALLET_LINK_REVOKED", "Wallet credential revoked", "receipt.preflight.wallet-link-revoked", "Reconnect matching wallet"],
    ["RUNTIME_GENERATION_STALE", "Wallet connection changed", "receipt.preflight.runtime-generation-stale", "Reconnect matching wallet"],
    ["WALLET_SESSION_REVISION_STALE", "Wallet session changed", "receipt.preflight.session-revision-stale", "Reconnect matching wallet"],
    ["WALLET_ACCOUNT_CHANGED", "Wallet account changed", "receipt.preflight.account-changed", "Reconnect matching wallet"],
    ["WRONG_NETWORK", "Wallet network does not match", "receipt.preflight.wrong-network", "Try again on Localnet rehearsal"],
    ["WALLET_SCOPE_MISSING", "Wallet permission changed", "receipt.preflight.scope-missing", "Reconnect wallet"],
    ["PROVIDER_CHANGED", "Wallet provider changed", "receipt.preflight.provider-changed", "Reconnect matching wallet"],
    ["REVIEW_FACTS_MISMATCH", "Reviewed facts changed", "receipt.preflight.review-facts-mismatch", "Review updated details"],
    ["POLICY_MISMATCH", "Receipt policy changed", "receipt.preflight.policy-mismatch", "Review updated details"],
  ] as const) {
    fixture.setPreflightReason(reason); await page.getByRole("button", { name: /check review readiness|check again/i }).click();
    await expect(page.getByRole("heading", { name: heading })).toBeFocused();
    await expect(page.getByText(reasonRef, { exact: true })).toBeVisible();
    await page.locator(".review-actions").last().getByRole("button", { name: recovery }).first().click();
    if (recovery === "Close review") {
      await expect(page.getByRole("dialog")).toHaveCount(0); await openReview();
    }
    if (recovery === "Close review" || recovery === "Review updated details" || recovery === "Prepare a fresh review") {
      if (recovery !== "Close review") await expect(page.getByRole("heading", { name: "Receipt review restored" })).toBeFocused();
      await expect(page.getByText("Wallet disconnected. The receipt details remain read-only.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Reconnect matching wallet" }).click();
    }
    await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  }
  fixture.setPreflightReason(null); await page.getByRole("button", { name: /check again|check review readiness/i }).click();
  await expect(page.getByRole("heading", { name: "Review ready" })).toBeFocused();

  const closeButton = page.getByRole("button", { name: "Close review" }).first(); await closeButton.focus(); await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Close review" }).last()).toBeFocused(); await page.keyboard.press("Tab"); await expect(closeButton).toBeFocused();
  await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "Review optional keepsake" })).toBeFocused();

  await setMode("DEFER"); await openReview(); await page.getByRole("button", { name: /connect wallet|reconnect matching/i }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __walletTripwires: { permission: number } }).__walletTripwires.permission)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close review" }).first().click();
  await page.evaluate((runtime) => { const state = (window as unknown as { __walletTest: { permissionResolver: null | ((value: unknown) => void) } }).__walletTest;
    state.permissionResolver?.(runtime); state.permissionResolver = null; }, expected);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const beforeSync = fixture.requests.filter((path) => path === "/api/account/wallet/runtime/sync").length;
  await expect.poll(() => fixture.requests.filter((path) => path === "/api/account/wallet/runtime/sync").length).toBe(beforeSync);
  const heldRestore = fixture.holdNextReview("/api/account/receipt/review/restore"); await openReview(); await heldRestore.started;
  await page.getByRole("button", { name: "Close review" }).first().click(); heldRestore.release(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __walletTripwires: Record<string, number> }).__walletTripwires))
    .toMatchObject({ sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 });
});

for (const boundary of ["headers", "body"] as const) {
  for (const path of ["/api/account/receipt/review/restore", "/api/account/wallet/runtime/sync",
    "/api/account/receipt/review/prepare", "/api/account/receipt/review/preflight"] as const) {
    test(`@receipt-review closing at the ${path} ${boundary} barrier retires every continuation`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "controlled response-boundary schedules are exercised once");
      const settled = (compiledFirstEveningService.goldenReplay.at(-1) as {
        readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
      const fixture = serviceFixture(settled, true); await fixture.install(page); await installControlledReviewBrowser(page); await page.goto("/");
      const barrier = await armReviewFetchBarrier(page, path, boundary);
      const invoker = page.getByRole("button", { name: "Review optional keepsake" }); await invoker.click();
      if (path !== "/api/account/receipt/review/restore") {
        await expect(page.getByRole("heading", { name: "Wallet account required" }).first()).toBeVisible();
        await page.getByRole("button", { name: /connect wallet/i }).click();
      }
      if (path === "/api/account/receipt/review/preflight") {
        await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
        await page.getByRole("button", { name: "Check review readiness" }).click();
      }
      await barrier.started();
      const requestCounts = Object.fromEntries(fixture.requests.map((request) => [request,
        fixture.requests.filter((candidate) => candidate === request).length]));
      const tripwiresAtBarrier = await reviewTripwires(page);
      if (path === "/api/account/receipt/review/preflight") {
        await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
        await expect(page.getByRole("button", { name: /checking|check review readiness|check again/iu })).toHaveCount(0);
        await page.getByRole("button", { name: "Not now" }).click();
      } else await page.getByRole("button", { name: "Close review" }).first().click();
      await barrier.release();
      await expect(page.getByRole("dialog")).toHaveCount(0); await expect(invoker).toBeFocused();
      await page.evaluate(() => Promise.resolve());
      if (path === "/api/account/receipt/review/restore") expect((await reviewTripwires(page)).permission).toBe(0);
      if (path === "/api/account/wallet/runtime/sync") {
        expect(fixture.requests.filter((request) => request === "/api/account/receipt/review/prepare")).toHaveLength(0);
      }
      if (path === "/api/account/receipt/review/prepare") expect((await reviewTripwires(page)).subscribe).toBe(0);
      if (path === "/api/account/receipt/review/preflight") {
        const after = await reviewTripwires(page); expect(after.permission).toBe(tripwiresAtBarrier.permission);
        expect(after.read).toBe(tripwiresAtBarrier.read); expect(after.subscribe).toBe(tripwiresAtBarrier.subscribe);
      }
      expect(Object.fromEntries(fixture.requests.map((request) => [request,
        fixture.requests.filter((candidate) => candidate === request).length]))).toEqual(requestCounts);
      expect(await reviewTripwires(page)).toMatchObject({ sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 });
    });
  }
}

test("@receipt-review a retired dynamic import cannot create a port or request permission", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the dynamic module boundary is exercised once");
  const settled = (compiledFirstEveningService.goldenReplay.at(-1) as {
    readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const fixture = serviceFixture(settled, true); await fixture.install(page); await installControlledReviewBrowser(page);
  await page.goto("/"); await page.evaluate(() => {
    (window as unknown as { __reviewBarrierControl: { armImport(): void } }).__reviewBarrierControl.armImport();
  });
  const invoker = page.getByRole("button", { name: "Review optional keepsake" }); await invoker.click();
  await expect(page.getByRole("heading", { name: "Wallet account required" }).first()).toBeVisible();
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __reviewBarrierControl: { startedImport(): number } }).__reviewBarrierControl.startedImport())).toBe(1);
  expect((await reviewTripwires(page)).permission).toBe(0);
  await page.getByRole("button", { name: "Close review" }).first().click();
  await page.evaluate(() => {
    (window as unknown as { __reviewBarrierControl: { releaseImport(): void } }).__reviewBarrierControl.releaseImport();
  });
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(invoker).toBeFocused();
  expect((await reviewTripwires(page)).permission).toBe(0);
  expect(fixture.requests.filter((path) => path === "/api/account/wallet/runtime/sync")).toHaveLength(0);
});

test("@receipt-review an old permission result resolving after a new connection cannot win", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the permission winner order is exercised once");
  const settled = (compiledFirstEveningService.goldenReplay.at(-1) as {
    readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const fixture = serviceFixture(settled, true); await fixture.install(page); await installControlledReviewBrowser(page); await page.goto("/");
  const setMode = (mode: string) => page.evaluate((next) => {
    (window as unknown as { __reviewBarrierState: { mode: string } }).__reviewBarrierState.mode = next;
  }, mode);
  const open = async () => { await page.getByRole("button", { name: "Review optional keepsake" }).click();
    await expect(page.getByRole("heading", { name: "Wallet account required" }).first()).toBeVisible(); };
  await setMode("DEFER"); await open(); await page.getByRole("button", { name: /connect wallet/i }).click();
  await expect.poll(() => reviewTripwires(page).then((value) => value.permission)).toBe(1);
  await page.getByRole("button", { name: "Close review" }).first().click(); await setMode("PERMISSIONED"); await open();
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  await page.evaluate((runtime) => { const state = (window as unknown as { __reviewBarrierState: {
    permissionResolvers: ((value: unknown) => void)[] } }).__reviewBarrierState; state.permissionResolvers.shift()?.(runtime); }, EXPECTED_REVIEW_RUNTIME);
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  expect(fixture.requests.filter((path) => path === "/api/account/wallet/runtime/sync")).toHaveLength(1);
  expect(fixture.requests.filter((path) => path === "/api/account/receipt/review/prepare")).toHaveLength(1);
});

for (const path of ["/api/account/wallet/runtime/sync", "/api/account/receipt/review/prepare"] as const) {
  for (const order of ["old-first", "old-last"] as const) {
    test(`@receipt-review ${path} ${order} cannot beat the reconnect generation`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "both reconnect winner orders are exercised once");
      const settled = (compiledFirstEveningService.goldenReplay.at(-1) as {
        readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
      const fixture = serviceFixture(settled, true); await fixture.install(page); await installControlledReviewBrowser(page); await page.goto("/");
      const barrier = await armReviewFetchBarrier(page, path, "headers");
      const invoker = page.getByRole("button", { name: "Review optional keepsake" }); await invoker.click();
      await expect(page.getByRole("heading", { name: "Wallet account required" }).first()).toBeVisible();
      await page.getByRole("button", { name: /connect wallet/i }).click(); await barrier.started();
      await page.getByRole("button", { name: "Close review" }).first().click();
      if (order === "old-first") await barrier.release();
      await invoker.click(); await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: /connect wallet|reconnect matching wallet/i }).click();
      await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
      if (order === "old-last") await barrier.release();
      await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
      expect(await reviewTripwires(page)).toMatchObject({ subscribe: 1, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 });
    });
  }
}

test("@receipt-review duplicate and contradictory runtime deliveries cannot revive retired coordinates", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the runtime delivery schedule is exercised once");
  const settled = (compiledFirstEveningService.goldenReplay.at(-1) as {
    readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const fixture = serviceFixture(settled, true); await fixture.install(page); await installControlledReviewBrowser(page); await page.goto("/");
  await page.getByRole("button", { name: "Review optional keepsake" }).click();
  await expect(page.getByRole("heading", { name: "Wallet account required" }).first()).toBeVisible();
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused();
  const before = fixture.requests.length;
  await page.evaluate((runtime) => { const state = (window as unknown as { __reviewBarrierState: {
    activeListeners: ((value: unknown) => void)[] } }).__reviewBarrierState;
    for (const listener of state.activeListeners) { listener(runtime); listener(runtime); }
  }, EXPECTED_REVIEW_RUNTIME);
  await expect(page.getByRole("heading", { name: "Wallet connected for review" })).toBeFocused(); expect(fixture.requests).toHaveLength(before);
  await page.evaluate((runtime) => { const state = (window as unknown as { __reviewBarrierState: {
    activeListeners: ((value: unknown) => void)[] } }).__reviewBarrierState;
    for (const listener of [...state.activeListeners]) listener({ ...runtime, account: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb" });
  }, EXPECTED_REVIEW_RUNTIME);
  await expect(page.getByRole("heading", { name: "Wallet account changed" })).toBeFocused();
  await page.evaluate((runtime) => { const state = (window as unknown as { __reviewBarrierState: {
    listenerHistory: ((value: unknown) => void)[] } }).__reviewBarrierState;
    for (const listener of state.listenerHistory) listener(runtime);
  }, EXPECTED_REVIEW_RUNTIME);
  await expect(page.getByRole("heading", { name: "Wallet account changed" })).toBeFocused(); expect(fixture.requests).toHaveLength(before);
  expect(await reviewTripwires(page)).toMatchObject({ unsubscribe: 1, sign: 0, send: 0, inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 });
});

test("lost response requeries then retries the byte-identical envelope without ceremony duplication", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "transport race is covered once");
  const fixture = serviceFixture();
  fixture.setDropNextAfterCommit();
  await fixture.install(page);
  await page.goto("/");
  await page.locator(".perform-action .primary-action").click();
  await expect(page.getByRole("heading", { name: /wash/i })).toBeVisible();
  await expect.poll(() => fixture.bodies.length).toBe(2);
  expect(fixture.bodies[1]).toBe(fixture.bodies[0]);
  await expect(page.locator(".serve-ceremony")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("without repeating service ceremony");
  expect(fixture.requests.filter((path) => path === "/api/account/cookies/reset" || path === "/api/account/guest/issue")).toEqual([]);
});

test("same-subject credential refresh requeries before an exact command retry without reset or duplicate gameplay", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "credential refresh transport is covered once");
  const fixture = serviceFixture();
  fixture.setCredentialRefreshNext();
  await fixture.install(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  expect(fixture.requests.filter((path) => path === "/api/account/service")).toHaveLength(2);

  fixture.setCredentialRefreshNext();
  await page.locator(".perform-action .primary-action").click();
  await expect(page.getByRole("heading", { name: /wash/i })).toBeVisible();
  await expect.poll(() => fixture.bodies.length).toBe(2);
  expect(fixture.bodies[1]).toBe(fixture.bodies[0]);
  expect(fixture.checkpoint()).toMatchObject({ phase: "OPEN", revision: 1, generation: 0 });
  expect(fixture.requests.filter((path) => path === "/api/account/cookies/reset" || path === "/api/account/guest/issue")).toEqual([]);
});

test("a pending command keeps the acknowledged projection inert and disables a second intent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "pending transport is covered once");
  const fixture = serviceFixture();
  await fixture.install(page);
  await page.goto("/");
  const held = fixture.holdNextCommand();
  await page.locator(".perform-action .primary-action").click();
  await held.started;
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  await expect(page.locator(".perform-action .primary-action")).toBeDisabled();
  await expect(page.locator(".identity-plaque")).toContainText("Saving command");
  expect(fixture.checkpoint().revision).toBe(0);
  held.release();
  await expect(page.getByRole("heading", { name: /wash/i })).toBeVisible();
  expect(fixture.checkpoint().revision).toBe(1);
});

test("lost serve response recovers the receipt without replaying feedback ceremony", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "serve replay is covered once");
  const beforeServe = (compiledFirstEveningService.goldenReplay[12] as { readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const fixture = serviceFixture(beforeServe);
  fixture.setDropNextAfterCommit();
  await fixture.install(page);
  await page.goto("/");
  await page.locator(".perform-action .primary-action").click();
  await expect.poll(() => fixture.bodies.length).toBe(2);
  expect(fixture.bodies[1]).toBe(fixture.bodies[0]);
  await expect(page.locator(".serve-ceremony")).toHaveCount(0);
  await expect(page.locator(".ledger-list article")).toHaveCount(1);
});

test("runtime failure retains the exact envelope and never invokes authority reset", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "runtime recovery is covered once");
  const fixture = serviceFixture();
  const diagnostics: string[] = [];
  page.on("console", (message) => diagnostics.push(message.text()));
  page.on("pageerror", (error) => diagnostics.push(error.message));
  await fixture.install(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  fixture.setUnavailable(true);
  await page.locator(".perform-action .primary-action").click();
  await expect(page.getByRole("button", { name: "Requery and recover exact command" })).toBeVisible();
  expect(fixture.bodies).toHaveLength(1);
  fixture.setUnavailable(false);
  await page.getByRole("button", { name: "Requery and recover exact command" }).click();
  await expect.poll(() => fixture.bodies.length).toBe(2);
  expect(fixture.bodies[1]).toBe(fixture.bodies[0]);
  await expect(page.getByRole("heading", { name: /wash/i })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("hostile-runtime-marker");
  expect(diagnostics.join("\n")).not.toMatch(/hostile-runtime-marker|cookie|subject|checkpoint|signature|proof|database|digest|hmac/iu);
  expect(fixture.requests.filter((path) => path === "/api/account/cookies/reset" || path === "/api/account/guest/issue")).toEqual([]);
});

test("two tabs fence a stale revision and converge on the canonical projection", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "multi-tab schedule is covered once");
  const fixture = serviceFixture();
  const second = await context.newPage();
  await fixture.install(page);
  await fixture.install(second);
  await Promise.all([page.goto("/"), second.goto("/")]);
  await Promise.all([page.locator(".perform-action .primary-action").click(), second.locator(".perform-action .primary-action").click()]);
  await Promise.all([
    expect(page.getByRole("heading", { name: /wash/i })).toBeVisible(),
    expect(second.getByRole("heading", { name: /wash/i })).toBeVisible(),
  ]);
  expect(fixture.checkpoint().revision).toBe(1);
  expect(new Set(fixture.bodies.map((body) => JSON.parse(body).idempotencyKey)).size).toBe(2);
  expect(fixture.requests.filter((path) => path === "/api/account/cookies/reset" || path === "/api/account/guest/issue")).toEqual([]);
});

test("a delayed old query cannot overwrite a newer canonical requery", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "response generation fence is covered once");
  const fixture = serviceFixture();
  const second = await context.newPage();
  await fixture.install(page);
  await fixture.install(second);
  await Promise.all([page.goto("/"), second.goto("/")]);
  await Promise.all([
    expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible(),
    expect(second.getByRole("heading", { name: "Start the first shift." })).toBeVisible(),
  ]);
  const held = fixture.holdNextQuery();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await held.started;
  await second.locator(".perform-action .primary-action").click();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: /wash/i })).toBeVisible();
  held.release();
  await expect(page.getByRole("heading", { name: /wash/i })).toBeVisible();
});

test("explicit authority recovery preserves a prior view and guest-to-player continuation requeries", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "authority transition is covered once");
  const fixture = serviceFixture();
  const diagnostics: string[] = [];
  page.on("console", (message) => diagnostics.push(message.text()));
  page.on("pageerror", (error) => diagnostics.push(error.message));
  await forceAnimationFrameBeforeReactCommit(page);
  await fixture.install(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  fixture.setIdentity("player");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Saved play · no wallet", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  fixture.setAuthorityRejected(true);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".blocking-banner")).toContainText("Service access needs recovery");
  expect(await page.locator("body").innerText()).not.toContain("hostile-authority-marker");
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  await page.getByRole("button", { name: "Recover service access" }).click();
  await expect(page.locator("header").getByText("Guest play · no wallet", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeFocused();
  expect(diagnostics.join("\n")).not.toMatch(/hostile-authority-marker|cookie|subject|checkpoint|signature|proof|database|digest|hmac/iu);
});

test("cold missing authority exposes only explicit privacy-safe recovery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "cold authority recovery is covered once");
  const fixture = serviceFixture();
  fixture.setAuthorityRejected(true);
  await forceAnimationFrameBeforeReactCommit(page);
  await fixture.install(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Service access needs recovery." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open guest service" })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("hostile-authority-marker");
  await page.getByRole("button", { name: "Open guest service" }).click();
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeFocused();
  await expect(page.locator("header").getByText("Guest play · no wallet", { exact: true })).toBeVisible();
});

test("a malformed projection fails closed without rendering raw server fields", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "malformed boundary is covered once");
  const response = { view: { ...viewFor(createInitialEveningServiceCheckpoint()), rawServerError: "hostile-projection-marker" } };
  await page.route("**/api/account/service", (route) => route.fulfill({ status: 200, contentType: "application/json",
    headers: { "Cache-Control": "no-store" }, body: JSON.stringify(response) }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Returning to the counter." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try service again" })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("hostile-projection-marker");
});

test("known-but-wrong projection fields cannot replace an acknowledged view or trigger cookie recovery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "mounted decoder failure is covered once");
  const fixture = serviceFixture();
  await fixture.install(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  fixture.setMalformedNextQuery();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".blocking-banner")).toContainText("temporarily unavailable");
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  expect(fixture.requests.filter((path) => path === "/api/account/cookies/reset" || path === "/api/account/guest/issue")).toEqual([]);
});

test("only the exact authority rejection enables destructive recovery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "negative authentication classification is covered once");
  const fixture = serviceFixture();
  await fixture.install(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  fixture.setWrongAuthorityResponse(true);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".blocking-banner")).toContainText("temporarily unavailable");
  await expect(page.getByRole("button", { name: "Recover service access" })).toHaveCount(0);
  expect(fixture.requests.filter((path) => path === "/api/account/cookies/reset" || path === "/api/account/guest/issue")).toEqual([]);
});

test("a query conflict preserves cookies and offers only nondestructive requery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "query conflict classification is covered once");
  const fixture = serviceFixture();
  await fixture.install(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();
  fixture.setConflictNextQuery();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".blocking-banner").getByRole("button", { name: "Requery saved service" })).toBeVisible();
  expect(fixture.requests.filter((path) => path === "/api/account/cookies/reset" || path === "/api/account/guest/issue")).toEqual([]);
});

test("abandon confirmation is modal, restores focus, and never claims settlement", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "dialog journey is covered once");
  const fixture = serviceFixture();
  await fixture.install(page);
  await page.goto("/");
  await page.locator(".perform-action .primary-action").click();
  const invoker = page.getByRole("button", { name: "End shift early" });
  await invoker.click();
  const dialog = page.getByRole("dialog", { name: "End this shift early?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep serving" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")))).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(invoker).toBeFocused();
  await invoker.click();
  await dialog.getByRole("button", { name: "End shift" }).click();
  await expect(page.getByText("Service abandoned", { exact: true })).toBeVisible();
  await expect(page.getByText("No settlement or unlock was recorded.", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved cosmetic restoration", { exact: true })).toHaveCount(0);
});

test("dark-surface focus indicators use the high-contrast focus token", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "focus contrast is covered once");
  const fixture = serviceFixture();
  await fixture.install(page);
  await page.goto("/");
  await page.locator(".perform-action .primary-action").click();
  await page.keyboard.press("Tab");

  const contrast = await page.evaluate(() => {
    const parse = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (color: string) => {
      const channels = parse(color).map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    const ratio = (foreground: string, background: string) => {
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (lighter! + 0.05) / (darker! + 0.05);
    };
    const nav = document.querySelector<HTMLElement>('.bottom-nav a[aria-current="page"]')!;
    const disclosure = document.querySelector<HTMLElement>(".runtime-disclosure summary")!;
    nav.focus();
    const navStyle = getComputedStyle(nav);
    const navColor = navStyle.outlineColor;
    const navContrast = ratio(navColor, getComputedStyle(nav.closest(".bottom-nav")!).backgroundColor);
    disclosure.focus();
    const disclosureStyle = getComputedStyle(disclosure);
    const disclosureColor = disclosureStyle.outlineColor;
    const disclosureContrast = ratio(disclosureColor, getComputedStyle(disclosure.closest(".ingredient-rail")!).backgroundColor);
    const choice = document.querySelector<HTMLInputElement>(".choice-tile input")!;
    choice.focus();
    const choiceColor = getComputedStyle(choice).outlineColor;
    const choiceContrast = ratio(choiceColor, getComputedStyle(choice.closest(".choice-tile")!).backgroundColor);
    return { navColor, disclosureColor, choiceColor, navContrast, disclosureContrast, choiceContrast };
  });

  expect(contrast.navColor).toBe("rgb(244, 208, 111)");
  expect(contrast.disclosureColor).toBe("rgb(244, 208, 111)");
  expect(contrast.choiceColor).toBe("rgb(36, 68, 94)");
  expect(contrast.navContrast).toBeGreaterThanOrEqual(3);
  expect(contrast.disclosureContrast).toBeGreaterThanOrEqual(3);
  expect(contrast.choiceContrast).toBeGreaterThanOrEqual(3);
});

test("abandoned guest and player projections start a canonical fresh run without replacing authority", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "terminal authority preservation is covered once");
  for (const identity of ["guest", "player"] as const) {
    const fixture = serviceFixture();
    fixture.setIdentity(identity);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await fixture.install(page);
    await page.goto("/");
    await page.locator(".perform-action .primary-action").click();
    await page.getByRole("button", { name: "End shift early" }).click();
    await page.getByRole("dialog", { name: "End this shift early?" }).getByRole("button", { name: "End shift" }).click();
    await expect(page.getByText("Service abandoned", { exact: true })).toBeVisible();
    const abandoned = fixture.checkpoint();
    const continuation = page.getByRole("button", { name: "Start a fresh shift" });
    await expect(continuation).toBeEnabled();
    fixture.setDropNextAfterCommit();
    await continuation.click();
    await expect.poll(() => fixture.bodies.filter((body) => JSON.parse(body).commandName === "service.start-new").length).toBe(2);
    await expect(page.locator("header").getByText(identity === "guest" ? "Guest play · no wallet" : "Saved play · no wallet", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /wash/i })).toBeVisible();
    expect(fixture.checkpoint()).toMatchObject({ phase: "OPEN", generation: abandoned.generation + 1, revision: abandoned.revision + 1,
      storyFlags: abandoned.storyFlags, unlocks: abandoned.unlocks });
    const startBodies = fixture.bodies.filter((body) => JSON.parse(body).commandName === "service.start-new");
    expect(startBodies[1]).toBe(startBodies[0]);
    expect(JSON.parse(startBodies[0]!)).toMatchObject({ expectedRevision: abandoned.revision, commandName: "service.start-new", payload: {} });
    expect(fixture.requests.filter((path) => path === "/api/account/cookies/reset" || path === "/api/account/guest/issue")).toEqual([]);
  }
});

test("two abandoned tabs admit one new generation and converge without cookie recovery", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "fresh-run contention is covered once");
  const abandoned = (compiledFirstEveningService.abandonmentReplay.at(-1) as { readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const fixture = serviceFixture(abandoned);
  const second = await context.newPage();
  await fixture.install(page);
  await fixture.install(second);
  await Promise.all([page.goto("/"), second.goto("/")]);
  await Promise.all([
    expect(page.getByText("Service abandoned", { exact: true })).toBeVisible(),
    expect(second.getByText("Service abandoned", { exact: true })).toBeVisible(),
  ]);
  await Promise.all([
    page.getByRole("button", { name: "Start a fresh shift" }).click(),
    second.getByRole("button", { name: "Start a fresh shift" }).click(),
  ]);
  await Promise.all([
    expect(page.getByRole("heading", { name: /wash/i })).toBeVisible(),
    expect(second.getByRole("heading", { name: /wash/i })).toBeVisible(),
  ]);
  expect(fixture.checkpoint()).toMatchObject({ phase: "OPEN", generation: abandoned.generation + 1, revision: abandoned.revision + 1 });
  const bodies = fixture.bodies.filter((body) => JSON.parse(body).commandName === "service.start-new");
  expect(new Set(bodies.map((body) => JSON.parse(body).idempotencyKey)).size).toBe(2);
  expect(fixture.requests.filter((path) => path === "/api/account/cookies/reset" || path === "/api/account/guest/issue")).toEqual([]);
});

test("every canonical revision reloads from the server with no replay ceremony", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "reload matrix is covered once");
  for (const item of compiledFirstEveningService.goldenReplay) {
    const checkpoint = "response" in item ? (item as { readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint : item as unknown as EveningServiceCheckpoint;
    const fixture = serviceFixture(checkpoint);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await fixture.install(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: viewFor(checkpoint).prompt.text })).toBeVisible();
    await expect(page.locator(".serve-ceremony")).toHaveCount(0);
  }
});

test("responsive topology, reflow, reduced motion, and integer sprite scaling stay exact", async ({ page }, testInfo) => {
  const checkpoint = (compiledFirstEveningService.goldenReplay[10] as { readonly response: { readonly checkpoint: EveningServiceCheckpoint } }).response.checkpoint;
  const fixture = serviceFixture(checkpoint);
  await fixture.install(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 780 : 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Choose one cosmetic presentation for the first plate." })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(2);
    await expect(page.locator("html")).toHaveJSProperty("scrollWidth", await page.locator("html").evaluate((node) => node.clientWidth));
    const ratios = await page.locator(".pixel-asset").evaluateAll((nodes) => nodes.map((node) => {
      const svg = node as SVGSVGElement;
      const box = svg.getBoundingClientRect();
      const intrinsicWidth = Number(svg.getAttribute("width"));
      const intrinsicHeight = Number(svg.getAttribute("height"));
      return [box.width / intrinsicWidth, box.height / intrinsicHeight];
    }).filter(([x, y]) => x > 0 && y > 0));
    for (const [x, y] of ratios) {
      expect(x).toBe(y);
      expect(Number.isInteger(x)).toBe(true);
      expect(x).toBeGreaterThan(0);
    }
    if (width >= 1180) await expect(page.locator(".ingredient-rail .legal-choices")).toBeVisible();
    else if (width >= 768) await expect(page.locator(".mise-sheet")).toHaveAttribute("open", "");
    else await expect(page.locator(".ingredient-rail")).toBeVisible();
    const semanticOrder = await page.evaluate(() => {
      const nodes = [document.querySelector("#service-task"), document.querySelector(".legal-choices"),
        document.querySelector(".service-facts"), document.querySelector(".perform-action")];
      return nodes.every((node, index) => index === 0 || Boolean(nodes[index - 1]?.compareDocumentPosition(node!) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(semanticOrder).toBe(true);
    if (testInfo.project.name === "mobile-320" && width === 320) {
      const radios = page.getByRole("radio");
      await expect(radios).toHaveCount(2);
      await radios.nth(1).tap();
      await expect(radios.nth(1)).toBeChecked();
    }
    if (width === 390) {
      await page.evaluate(() => { document.documentElement.style.filter = "grayscale(1)"; });
      await page.getByRole("radio").first().check();
      await expect(page.locator(".choice-tile.is-selected input")).toBeChecked();
      expect(await page.locator(".pixel-asset").evaluateAll((nodes) => nodes.every((node) => Boolean(node.getAttribute("aria-label"))))).toBe(true);
      await page.evaluate(() => { document.documentElement.style.filter = ""; });
    }
    if (testInfo.project.name === "desktop" && (width === 390 || width === 1440)) {
      if (width === 390) await page.locator(".mise-sheet").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `.scratch/first-service-browser/confirmation-${width === 1440 ? "desktop" : "mobile"}.png`, fullPage: false });
    }
  }
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto("/");
  await page.locator(".perform-action").scrollIntoViewIfNeeded();
  const actionBox = await page.locator(".perform-action").boundingBox();
  const navBox = await page.locator(".bottom-nav").boundingBox();
  expect(actionBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
  const reducedDuration = await page.locator(".primary-action").evaluate((node) => getComputedStyle(node).animationDuration);
  expect(Number.parseFloat(reducedDuration)).toBeLessThanOrEqual(0.000001);
  await page.setViewportSize({ width: 160, height: 720 });
  const overflows = await page.locator("body *").evaluateAll((nodes) => nodes.flatMap((node) => {
    const box = node.getBoundingClientRect();
    return box.right > document.documentElement.clientWidth + 0.5
      ? [{ tag: node.tagName, className: (node as HTMLElement).className, left: box.left, right: box.right, width: box.width }]
      : [];
  }));
  expect(overflows).toEqual([]);
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", await page.locator("html").evaluate((node) => node.clientWidth));
});

test("the complete manifest renders as an undistorted non-color asset proof sheet", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "asset proof sheet is captured once");
  await page.goto("/");
  const assets = Object.entries(FIRST_SERVICE_BROWSER_INVENTORY.assets);
  await page.setContent(`<main style="display:grid;grid-template-columns:repeat(4,minmax(340px,1fr));gap:12px;background:#f4e9d2;padding:16px">${assets.map(([key, asset]) => `<figure style="margin:0;border:2px solid #171611;padding:8px;min-width:0"><svg role="img" aria-label="${asset.nonColorIdentity}" viewBox="0 0 ${asset.width} ${asset.height}" width="${asset.width}" height="${asset.height}" style="display:block;width:${asset.width}px;height:${asset.height}px;shape-rendering:crispEdges"><use href="${asset.path}"></use></svg><figcaption style="font:12px sans-serif;overflow-wrap:anywhere">${key}<br>${asset.nonColorIdentity}</figcaption></figure>`).join("")}</main>`);
  const ratios = await page.locator("svg").evaluateAll((nodes) => nodes.map((node) => {
    const svg = node as SVGSVGElement;
    const box = svg.getBoundingClientRect();
    return [box.width / Number(svg.getAttribute("width")), box.height / Number(svg.getAttribute("height"))];
  }));
  expect(ratios.every(([x, y]) => x === 1 && y === 1)).toBe(true);
  await expect(page.getByRole("img")).toHaveCount(44);
  await page.screenshot({ path: ".scratch/first-service-browser/asset-proof-sheet.png", fullPage: true });
});

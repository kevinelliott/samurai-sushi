import { expect, test, type Page, type Route } from "@playwright/test";
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
  readonly holdNextQuery: () => { readonly release: () => void; readonly started: Promise<void> };
  readonly holdNextCommand: () => { readonly release: () => void; readonly started: Promise<void> };
  readonly checkpoint: () => EveningServiceCheckpoint;
}

function serviceFixture(initial = createInitialEveningServiceCheckpoint()): RouteFixture {
  let checkpoint = initial;
  let dropNextAfterCommit = false;
  let unavailable = false;
  let authorityRejected = false;
  let wrongAuthorityResponse = false;
  let credentialRefreshNext = false;
  let malformedNextQuery = false;
  let conflictNextQuery = false;
  let identity: "guest" | "player" = "guest";
  let heldQuery: { readonly started: () => void; readonly wait: Promise<void>; readonly release: () => void } | null = null;
  let heldCommand: { readonly started: () => void; readonly wait: Promise<void>; readonly release: () => void } | null = null;
  const receipts = new Map<string, { readonly body: string; readonly checkpoint: EveningServiceCheckpoint; readonly cue: string | null }>();
  const bodies: string[] = [];
  const requests: string[] = [];

  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  const handle = async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === "/api/account/cookies/reset") return json(route, 200, { reset: true });
    if (path === "/api/account/guest/issue") {
      checkpoint = createInitialEveningServiceCheckpoint();
      identity = "guest";
      authorityRejected = false;
      return json(route, 200, { issued: true });
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
  const diagnostics: string[] = [];
  page.on("console", (message) => diagnostics.push(message.text()));
  page.on("pageerror", (error) => diagnostics.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start the first shift." })).toBeVisible();

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
  await expect(page.getByRole("button", { name: /wallet/i })).toHaveCount(0);
  expect(new Set(fixture.bodies.map((body) => JSON.parse(body).idempotencyKey)).size).toBe(29);
  const renderedText = await page.locator("body").innerText();
  for (const body of fixture.bodies) expect(renderedText).not.toContain((JSON.parse(body) as PublicCommand).idempotencyKey);
  expect(diagnostics.join("\n")).not.toMatch(/hostile|cookie|subject|checkpoint|signature|proof|database|digest|hmac/iu);
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
  expect(diagnostics.join("\n")).not.toMatch(/hostile-authority-marker|cookie|subject|checkpoint|signature|proof|database|digest|hmac/iu);
});

test("cold missing authority exposes only explicit privacy-safe recovery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "cold authority recovery is covered once");
  const fixture = serviceFixture();
  fixture.setAuthorityRejected(true);
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

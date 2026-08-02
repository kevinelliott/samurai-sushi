import { describe, expect, it } from "vitest";
import { buildBrowserEveningServiceView, compiledFirstEveningService } from "../../../packages/content/src/index";
import { createInitialEveningServiceCheckpoint, projectEveningService } from "@samurai-sushi/domain/evening-service";
import { createIntentEnvelope, decodeServiceResponse, isServiceAuthorityRejection, isServiceCredentialRefreshed } from "./service-browser";
import { FIRST_SERVICE_BROWSER_INVENTORY } from "./service-browser-inventory.generated";

function validResponse(): Record<string, unknown> {
  const checkpoint = createInitialEveningServiceCheckpoint();
  const projection = projectEveningService(checkpoint, compiledFirstEveningService.projectionManifest, { disposition: "query", correctiveCueId: null });
  return JSON.parse(JSON.stringify({ view: buildBrowserEveningServiceView(checkpoint, projection, "guest") })) as Record<string, unknown>;
}

function mutate(mutator: (view: Record<string, unknown>) => void): unknown {
  const response = validResponse();
  mutator(response.view as Record<string, unknown>);
  return response;
}

function responseForPrompt(promptRef: string, disposition: "query" | "committed" | "replayed" = "query"): Record<string, unknown> {
  const entries = [
    ...compiledFirstEveningService.goldenReplay,
    ...compiledFirstEveningService.correctiveReplay,
    ...compiledFirstEveningService.abandonmentReplay,
    ...compiledFirstEveningService.newRunReplay,
  ];
  for (const entry of entries) {
    const replayEntry = entry as unknown as { readonly response?: { readonly checkpoint: ReturnType<typeof createInitialEveningServiceCheckpoint> } };
    const checkpoint = replayEntry.response?.checkpoint ?? entry as unknown as ReturnType<typeof createInitialEveningServiceCheckpoint>;
    const projection = projectEveningService(checkpoint, compiledFirstEveningService.projectionManifest, { disposition, correctiveCueId: null });
    if (projection.currentPromptId === promptRef) {
      return JSON.parse(JSON.stringify({ view: buildBrowserEveningServiceView(checkpoint, projection, "guest") })) as Record<string, unknown>;
    }
  }
  throw new Error(`missing prompt fixture: ${promptRef}`);
}

describe("first-service browser decoder", () => {
  it("accepts and deeply freezes the generated exact view and immutable envelope", () => {
    const view = decodeServiceResponse(validResponse());
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.choices)).toBe(true);
    expect(Object.isFrozen(view.choices[0]!.payload)).toBe(true);
    const envelope = createIntentEnvelope(view, view.choices[0]!);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.payload)).toBe(true);
    expect(envelope.canonicalBody).toBe(JSON.stringify({ idempotencyKey: envelope.idempotencyKey,
      expectedRevision: 0, commandName: "service.start", payload: {} }));
  });

  it.each([
    ["unknown response key", (view: Record<string, unknown>) => { view.extra = true; }],
    ["identity label mismatch", (view: Record<string, unknown>) => { view.identityLabel = "Saved play · no wallet"; }],
    ["unknown prompt ref", (view: Record<string, unknown>) => { (view.prompt as Record<string, unknown>).ref = "prompt.unknown"; }],
    ["unknown command", (view: Record<string, unknown>) => { ((view.choices as Record<string, unknown>[])[0]!).commandName = "service.unknown"; }],
    ["wrong command payload", (view: Record<string, unknown>) => { ((view.choices as Record<string, unknown>[])[0]!).payload = { stepId: "start" }; }],
    ["unknown choice", (view: Record<string, unknown>) => { ((view.choices as Record<string, unknown>[])[0]!).id = "invented"; }],
    ["wrong order binding", (view: Record<string, unknown>) => { (((view.orders as Record<string, unknown>[])[0]!).guest as Record<string, unknown>).ref = "guest.courier"; }],
    ["unknown asset key", (view: Record<string, unknown>) => { (((view.orders as Record<string, unknown>[])[0]!).portrait as Record<string, unknown>).key = "guest-unknown"; }],
    ["asset dimension drift", (view: Record<string, unknown>) => { (((view.orders as Record<string, unknown>[])[0]!).portrait as Record<string, unknown>).width = 31; }],
    ["illegal abandon", (view: Record<string, unknown>) => { view.abandonChoice = (validResponse().view as Record<string, unknown>).abandonChoice ?? { id: "abandon" }; }],
    ["terminal choices", (view: Record<string, unknown>) => { view.phase = "SETTLED"; }],
  ])("fails closed for %s", (_name, alter) => {
    expect(() => decodeServiceResponse(mutate(alter))).toThrow(/unavailable/u);
  });

  it.each([
    ["known later rice beat", "prompt.rice.wash", (view: Record<string, unknown>) => {
      const choice = (view.choices as Record<string, unknown>[])[0]!;
      choice.id = "season"; choice.payload = { beat: "season" };
    }],
    ["known later station step", "prompt.step.ceramicist-kappa.layer-nori", (view: Record<string, unknown>) => {
      const choice = (view.choices as Record<string, unknown>[])[0]!;
      choice.id = "roll"; choice.payload = { orderId: "ceramicist-kappa", stepId: "roll" };
    }],
    ["another known order", "prompt.order.accept.ceramicist-kappa", (view: Record<string, unknown>) => {
      const choice = (view.choices as Record<string, unknown>[])[0]!;
      choice.id = "fishmonger-tamago"; choice.payload = { orderId: "fishmonger-tamago" };
    }],
    ["globally valid wrong copy", "prompt.rice.wash", (view: Record<string, unknown>) => {
      const replacement = (responseForPrompt("prompt.rice.steam").view as Record<string, unknown>).prompt;
      (view.choices as Record<string, unknown>[])[0]!.label = replacement;
    }],
    ["globally valid wrong asset", "prompt.presentation.choose", (view: Record<string, unknown>) => {
      const choices = view.choices as Record<string, unknown>[];
      choices[0]!.asset = choices[1]!.asset;
    }],
    ["terminal ledger prefix drift", "prompt.service.settled", (view: Record<string, unknown>) => {
      (view.ledgerRows as unknown[]).pop();
    }],
    ["terminal unlock drift", "prompt.service.settled", (view: Record<string, unknown>) => {
      view.unlock = (responseForPrompt("prompt.service.start").view as Record<string, unknown>).unlock;
    }],
    ["invalid query ceremony", "prompt.service.start", (view: Record<string, unknown>) => { view.announceCeremony = true; }],
    ["invalid committed ceremony", "prompt.service.start", (view: Record<string, unknown>) => {
      view.disposition = "committed"; view.announceCeremony = false;
    }],
  ])("rejects prompt-exact substitution: %s", (_name, promptRef, alter) => {
    const response = responseForPrompt(promptRef as string);
    alter(response.view as Record<string, unknown>);
    expect(() => decodeServiceResponse(response)).toThrow(/unavailable/u);
  });

  it("recognizes only the exact privacy-safe service authentication response", async () => {
    expect(await isServiceAuthorityRejection(new Response(JSON.stringify({ code: "SERVICE_AUTHORITY_REJECTED", message: "Service access could not be authenticated." }), { status: 401 }))).toBe(true);
    expect(await isServiceAuthorityRejection(new Response(JSON.stringify({ code: "REQUEST_REJECTED", message: "Service access could not be authenticated." }), { status: 401 }))).toBe(false);
    expect(await isServiceAuthorityRejection(new Response(JSON.stringify({ code: "SERVICE_AUTHORITY_REJECTED", message: "hostile" }), { status: 401 }))).toBe(false);
    expect(await isServiceAuthorityRejection(new Response(JSON.stringify({ code: "SERVICE_AUTHORITY_REJECTED", message: "Service access could not be authenticated." }), { status: 409 }))).toBe(false);
  });

  it("recognizes only the exact same-subject credential refresh response", async () => {
    expect(await isServiceCredentialRefreshed(new Response(JSON.stringify({ code: "SERVICE_CREDENTIAL_REFRESHED", message: "Service access was refreshed. Requery the saved service." }), { status: 428 }))).toBe(true);
    expect(await isServiceCredentialRefreshed(new Response(JSON.stringify({ code: "SERVICE_CREDENTIAL_REFRESHED", message: "hostile" }), { status: 428 }))).toBe(false);
    expect(await isServiceCredentialRefreshed(new Response(JSON.stringify({ code: "SERVICE_CREDENTIAL_REFRESHED", message: "Service access was refreshed. Requery the saved service." }), { status: 401 }))).toBe(false);
  });

  it("pins positive intrinsic dimensions and complete safe inventories", () => {
    expect(Object.keys(FIRST_SERVICE_BROWSER_INVENTORY.assetDimensions)).toHaveLength(44);
    for (const [width, height] of Object.values(FIRST_SERVICE_BROWSER_INVENTORY.assetDimensions)) {
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    }
    expect(FIRST_SERVICE_BROWSER_INVENTORY.commandNames).toEqual([
      "service.start", "service.start-new", "service.prepare-rice", "service.accept-order", "service.perform-step", "service.choose-presentation",
      "service.plate-order", "service.serve-order", "service.close-ledger", "service.choose-restoration", "service.abandon",
    ]);
  });
});

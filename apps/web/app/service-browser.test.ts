import { describe, expect, it } from "vitest";
import { buildBrowserEveningServiceView, compiledFirstEveningService } from "../../../packages/content/src/index";
import { createInitialEveningServiceCheckpoint, projectEveningService } from "@samurai-sushi/domain/evening-service";
import { createIntentEnvelope, decodeServiceResponse } from "./service-browser";
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

  it("pins positive intrinsic dimensions and complete safe inventories", () => {
    expect(Object.keys(FIRST_SERVICE_BROWSER_INVENTORY.assetDimensions)).toHaveLength(44);
    for (const [width, height] of Object.values(FIRST_SERVICE_BROWSER_INVENTORY.assetDimensions)) {
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    }
    expect(FIRST_SERVICE_BROWSER_INVENTORY.commandNames).toEqual([
      "service.start", "service.prepare-rice", "service.accept-order", "service.perform-step", "service.choose-presentation",
      "service.plate-order", "service.serve-order", "service.close-ledger", "service.choose-restoration", "service.abandon",
    ]);
  });
});

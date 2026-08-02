import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectEveningService, type EveningServiceCheckpoint } from "@samurai-sushi/domain/evening-service";
import { FIRST_EVENING_SERVICE_DEFINITION } from "@samurai-sushi/domain/evening-service";
import { compileContentPack, recipeSnapshot } from "./compile";
import { ContentValidationError } from "./errors";
import { firstEveningServiceCatalogBundle } from "./fixtures/first-service";
import { canonicalContentJson, contentHashFor, contentManifestHashFor } from "./hash";
import type { ContentBundle, PreparedComponent } from "./model";
import { compiledFirstEveningService, compileFirstServiceContent, firstEveningServiceCanonicalBytes, firstEveningServiceSource } from "./service";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

const rehash = <T extends object>(row: T): T & { contentHash: string } => ({ ...row, contentHash: contentHashFor(row) });

function cloneCatalog(): Mutable<ContentBundle> {
  return structuredClone(firstEveningServiceCatalogBundle) as Mutable<ContentBundle>;
}

function syncCatalog(bundle: Mutable<ContentBundle>): void {
  bundle.pack = rehash({
    ...bundle.pack,
    ingredientRefs: bundle.ingredients.map(({ id, version }) => ({ id, version })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.version - right.version),
    componentRefs: bundle.components.map(({ id, version }) => ({ id, version })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.version - right.version),
    contentManifestHash: contentManifestHashFor(bundle),
    artAssetMapHash: contentHashFor(bundle.artAssets),
  });
}

function replacePreparedRice(bundle: Mutable<ContentBundle>, update: (component: Mutable<PreparedComponent>) => Mutable<PreparedComponent>): void {
  const index = bundle.components.findIndex((row) => row.id === "prepared-sushi-rice");
  const current = bundle.components[index]!;
  bundle.components[index] = rehash(update(current));
  syncCatalog(bundle);
}

function validationMessages(input: unknown): readonly string[] {
  try {
    compileContentPack(input);
    throw new Error("expected content validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ContentValidationError);
    return (error as ContentValidationError).issues.map((issue) => issue.message);
  }
}

describe("first evening service content compiler", () => {
  it("pins the content, art, service, manifest, and replay inventories", () => {
    expect(compiledFirstEveningService.source.firstServiceCatalog.entities
      .filter((entry) => entry.kind === "dish").map((entry) => entry.ref.id)).toEqual(["kappa-maki", "salmon-nigiri", "tamago-nigiri"]);
    expect(compiledFirstEveningService.source.salmonSashimiUnlockCatalog.entities.map((entry) => entry.kind)).toEqual([
      "component", "cut-style", "dish", "family", "ingredient", "recipe", "species",
    ]);
    expect(compiledFirstEveningService.goldenReplay).toHaveLength(30);
    expect(compiledFirstEveningService.correctiveReplay).toHaveLength(4);
    expect(compiledFirstEveningService.abandonmentReplay).toHaveLength(9);
    expect(compiledFirstEveningService.terminalReplay).toHaveLength(2);
    expect(compiledFirstEveningService.source.firstServiceCatalog.packContentHash).toBe("sha256:6499e22dbfc30f6e817029f96f0e199b700103d831b874d2a75316f29c4c88d9");
    expect(compiledFirstEveningService.contentManifestHash).toBe("sha256:697136e190a573bad3c6c135a0842c1620c05bd08a840fce4fdf04639f4ae3a1");
    expect(compiledFirstEveningService.artAssetMapHash).toBe("sha256:9c924461bf9d601c50ea9d8f086c15254dc26bb670a1cb81d253a9f55d8c70ad");
    expect(compiledFirstEveningService.serviceHash).toBe("sha256:1fdaf199ec3d39fe9cb7af084000481e7349f3d96d2aad5b181b316799c0cd7b");
    expect(compiledFirstEveningService.replayHash).toBe("sha256:3b923d2c165153f0c5daec7cbb706f23ac1de848b96b35db241309e45721d3b4");
    expect(compiledFirstEveningService.correctiveReplayHash).toBe("sha256:637e0d17efbd71f702aa2d8b37822e2be117a3e4086e2e41f0cf4deadbe12cb7");
    expect(compiledFirstEveningService.abandonmentReplayHash).toBe("sha256:97d514cbbb507968f6b15151087b58a88b22d3928a2c6356187cb1ec7f375eaa");
    expect(compiledFirstEveningService.terminalReplayHash).toBe("sha256:691656622bcc341186efbee76dbf025013e96150fb38bcc967bcf3782cc269ac");
    expect(createHash("sha256").update(firstEveningServiceCanonicalBytes).digest("hex")).toBe("9af8c262e902260e613ae96be2d716631c09234cc53109ba79e0a359c115a52a");
    expect(Object.isFrozen(compiledFirstEveningService)).toBe(true);
  });

  it("binds every first-service order to the exact transitive seasoned-rice ingredients", () => {
    const compiled = compileContentPack(firstEveningServiceCatalogBundle);
    const preparedRice = compiled.bundle.components.find((row) => row.id === "prepared-sushi-rice")!;
    expect(preparedRice.ingredientRef).toEqual({ id: "sushi-rice", version: 1 });
    expect(preparedRice.preparationInputs).toEqual([{
      ingredientRef: { id: "rice-vinegar", version: 1 },
      stationStep: { station: "rice-hearth", action: "season" },
    }]);
    for (const order of FIRST_EVENING_SERVICE_DEFINITION.orders) {
      const recipe = compiled.bundle.recipes.find((row) => row.dishRef.id === order.dishId)!;
      expect(recipe.exactComponentAmounts.some((amount) => amount.componentRef.id === "prepared-sushi-rice")).toBe(true);
      expect(recipeSnapshot(compiled.bundle, { id: recipe.id, version: recipe.version })).toContain("rice-vinegar");
    }
  });

  it("rejects missing, orphaned, duplicated, action-drifted, and unversioned preparation inputs", () => {
    const missing = cloneCatalog();
    replacePreparedRice(missing, (component) => {
      const { preparationInputs: _preparationInputs, ...rest } = component;
      return rest as Mutable<PreparedComponent>;
    });
    expect(validationMessages(missing)).toContain("A seasoned component requires exactly one versioned seasoning input bound to the season action.");

    const orphaned = cloneCatalog();
    replacePreparedRice(orphaned, (component) => ({ ...component, preparationInputs: [{
      ingredientRef: { id: "missing-vinegar", version: 1 },
      stationStep: { station: "rice-hearth", action: "season" },
    }] }));
    expect(validationMessages(orphaned).some((message) => /unknown ingredient reference/i.test(message))).toBe(true);

    const duplicated = cloneCatalog();
    replacePreparedRice(duplicated, (component) => ({ ...component, preparationInputs: [
      ...component.preparationInputs!, ...component.preparationInputs!,
    ] }));
    expect(validationMessages(duplicated)).toContain("Set-like arrays must be sorted by code point and contain no duplicates.");

    const actionDrifted = cloneCatalog();
    replacePreparedRice(actionDrifted, (component) => ({ ...component, preparationInputs: [{
      ingredientRef: { id: "rice-vinegar", version: 1 },
      stationStep: { station: "rice-hearth", action: "wash" },
    }] }));
    expect(validationMessages(actionDrifted)).toContain("A seasoned component requires exactly one versioned seasoning input bound to the season action.");

    const unversioned = cloneCatalog() as unknown as Record<string, unknown>;
    const unversionedComponents = unversioned.components as Array<Record<string, unknown>>;
    const index = unversionedComponents.findIndex((row) => row.id === "prepared-sushi-rice");
    unversionedComponents[index] = rehash({ ...unversionedComponents[index]!, preparationInputs: [{
      ingredientRef: "rice-vinegar@1",
      stationStep: { station: "rice-hearth", action: "season" },
    }] });
    syncCatalog(unversioned as unknown as Mutable<ContentBundle>);
    expect(validationMessages(unversioned)).toContain("Expected a plain object.");
  });

  it("projects the complete settled ledger and continuing story facts from pinned content", () => {
    const terminal = compiledFirstEveningService.goldenReplay.at(-1) as { response: { checkpoint: EveningServiceCheckpoint } };
    const projection = projectEveningService(terminal.response.checkpoint, compiledFirstEveningService.projectionManifest, { disposition: "replayed", correctiveCueId: null });
    expect(projection.ledgerRows).toHaveLength(3);
    expect(projection.ledgerRows.map((row) => ({ orderId: row.orderId, guestRef: row.guestRef, dishRef: row.dishRef, outcomeRef: row.outcomeRef }))).toEqual([
      { orderId: "ceramicist-kappa", guestRef: "guest.ceramicist", dishRef: "dish.kappa-maki", outcomeRef: "outcome.delighted" },
      { orderId: "fishmonger-tamago", guestRef: "guest.fishmonger", dishRef: "dish.tamago-nigiri", outcomeRef: "outcome.content" },
      { orderId: "courier-salmon", guestRef: "guest.courier", dishRef: "dish.salmon-nigiri", outcomeRef: "outcome.content" },
    ]);
    expect(projection.displayRefs).toContain("presentation.indigo-rim");
    expect(projection.displayRefs).toContain("restoration.mend-counter-stool");
    expect(projection.announceCeremony).toBe(false);
  });

  it("rejects definition, review, and art-map drift", () => {
    expect(() => compileFirstServiceContent({ ...firstEveningServiceSource, reviewReferences: [] })).toThrow();
    expect(() => compileFirstServiceContent({ ...firstEveningServiceSource,
      serviceDefinition: { ...firstEveningServiceSource.serviceDefinition, id: "changed" } })).toThrow();
    const first = firstEveningServiceSource.artRequirements[0]!;
    expect(() => compileFirstServiceContent({ ...firstEveningServiceSource,
      artRequirements: [{ ...first, digest: "sha256:" + "0".repeat(64) }, ...firstEveningServiceSource.artRequirements.slice(1)] })).toThrow();
    expect(() => compileFirstServiceContent({ ...firstEveningServiceSource,
      firstServiceCatalog: { ...firstEveningServiceSource.firstServiceCatalog,
        entities: firstEveningServiceSource.firstServiceCatalog.entities.slice(1) } })).toThrow();
  });

  it("compiles detached copies to the same literal bytes without mutating source", () => {
    const before = canonicalContentJson(firstEveningServiceSource);
    const detached = JSON.parse(before);
    const first = compileFirstServiceContent(detached);
    const second = compileFirstServiceContent(JSON.parse(before));
    expect(canonicalContentJson(first)).toBe(canonicalContentJson(second));
    expect(first.replayHash).toBe(compiledFirstEveningService.replayHash);
    expect(canonicalContentJson(firstEveningServiceSource)).toBe(before);
  });

  it("keeps canonical bytes walletless and secret-free", () => {
    const bytes = canonicalContentJson(compiledFirstEveningService);
    expect(bytes).not.toMatch(/wallet|signature|publicKey|chainId|tezos|tz1|nonce|secret|bearer|digestKey|hmac|rpc|indexer/i);
  });
});

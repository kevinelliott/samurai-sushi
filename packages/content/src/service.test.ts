import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { projectEveningService, type EveningServiceCheckpoint } from "@samurai-sushi/domain/evening-service";
import { FIRST_EVENING_SERVICE_DEFINITION } from "@samurai-sushi/domain/evening-service";
import { compileContentPack, recipeSnapshot } from "./compile";
import { ContentValidationError } from "./errors";
import { firstEveningServiceCatalogBundle } from "./fixtures/first-service";
import { canonicalContentJson, contentHashFor, contentManifestHashFor } from "./hash";
import type { ContentBundle, PreparedComponent } from "./model";
import { compiledFirstEveningService, compileFirstServiceContent, firstEveningServiceCanonicalBytes, firstEveningServiceSource } from "./service";
import { attestedFirstServiceBrowserAssets, buildBrowserEveningServiceView, firstServiceBrowserAssetManifestHash } from "./browser-view";
import { verifyFirstServiceSpriteAttestation } from "./asset-attestation";
import { FIRST_SERVICE_SPRITE_ATTESTATION } from "./browser-assets-attestation.generated";

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
    expect(compiledFirstEveningService.newRunReplay).toHaveLength(5);
    expect(compiledFirstEveningService.terminalReplay).toHaveLength(2);
    expect(compiledFirstEveningService.source.firstServiceCatalog.packContentHash).toBe("sha256:6499e22dbfc30f6e817029f96f0e199b700103d831b874d2a75316f29c4c88d9");
    expect(compiledFirstEveningService.contentManifestHash).toBe("sha256:a4a54539c31af18675d0302c4e180039a099fcdaa0e178962517b72003365180");
    expect(compiledFirstEveningService.artAssetMapHash).toBe("sha256:2b6c9ac0b139e8bd6fe20e6c63371f8ed1120726593e1ac142997dfb55691b3f");
    expect(compiledFirstEveningService.serviceHash).toBe("sha256:2e24887d7066bc811d1f10fd911a4b0109be7308a823052d239ab439683e44c5");
    expect(compiledFirstEveningService.replayHash).toBe("sha256:21fa4dcb57878d1854449beb4bd0a4ba4faf794848aba76d07621293af823e2f");
    expect(compiledFirstEveningService.correctiveReplayHash).toBe("sha256:14bddcb47912b3a2db2c802bb6233ce1e22e6b7d574915678bac1f2dfb372ebd");
    expect(compiledFirstEveningService.abandonmentReplayHash).toBe("sha256:ce101e3a1d5647ff58c5381038cc7f4b5af96599701fd98be7f1985991dbbf3c");
    expect(compiledFirstEveningService.newRunReplayHash).toBe("sha256:e9c8fc096587e399efeacde06d7b040b32742373b2fece0bf68f7600b1a327fa");
    expect(compiledFirstEveningService.terminalReplayHash).toBe("sha256:c3590f4756959dc53bf3a3dbeea3d1b2f3dbadffd4535b22d1a8f4ebb4b6c239");
    expect(createHash("sha256").update(firstEveningServiceCanonicalBytes).digest("hex")).toBe("9809b5d11a267fd30dc3802d3d595c2e0a12be7965724a1d93eaead8727c89ad");
    expect(firstServiceBrowserAssetManifestHash).toBe("sha256:deda1b1f3763d66ae8b527b8620c23321f4b3d5e89735bd712747a65e3a4cde6");
    expect(attestedFirstServiceBrowserAssets).toHaveLength(44);
    expect(FIRST_SERVICE_SPRITE_ATTESTATION.fileDigest).toBe("sha256:8fd8e0a21c812e02e0bff0c16fc50bdbc774c0c60cad9dfcf60e45f693138436");
    expect(Object.isFrozen(compiledFirstEveningService)).toBe(true);
  });

  it("attests the exact sprite bytes and rejects body, viewBox, missing, duplicate, and orphan drift", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../../apps/web/public/service-assets/first-service.svg"), "utf8");
    expect(verifyFirstServiceSpriteAttestation(source, firstEveningServiceSource.artRequirements, FIRST_SERVICE_SPRITE_ATTESTATION).fileDigest)
      .toBe(FIRST_SERVICE_SPRITE_ATTESTATION.fileDigest);
    expect(() => verifyFirstServiceSpriteAttestation(source.replace("#f4e9d2", "#f4e9d3"), firstEveningServiceSource.artRequirements, FIRST_SERVICE_SPRITE_ATTESTATION)).toThrow(/pinned attestation/u);
    expect(() => verifyFirstServiceSpriteAttestation(source.replace('viewBox="0 0 320 180"', 'viewBox="0 0 319 180"'), firstEveningServiceSource.artRequirements, FIRST_SERVICE_SPRITE_ATTESTATION)).toThrow(/viewBox/u);
    const firstSymbol = source.match(/<symbol id="counter-curtain-closed"[\s\S]*?<\/symbol>\n/u)?.[0];
    expect(firstSymbol).toBeTruthy();
    expect(() => verifyFirstServiceSpriteAttestation(source.replace(firstSymbol!, ""), firstEveningServiceSource.artRequirements, FIRST_SERVICE_SPRITE_ATTESTATION)).toThrow(/Missing/u);
    expect(() => verifyFirstServiceSpriteAttestation(source.replace(firstSymbol!, `${firstSymbol!}${firstSymbol!}`), firstEveningServiceSource.artRequirements, FIRST_SERVICE_SPRITE_ATTESTATION)).toThrow(/Duplicate/u);
    expect(() => verifyFirstServiceSpriteAttestation(source.replace("</svg>\n", '<symbol id="orphan" viewBox="0 0 1 1"><rect width="1" height="1"/></symbol>\n</svg>\n'), firstEveningServiceSource.artRequirements, FIRST_SERVICE_SPRITE_ATTESTATION)).toThrow(/Orphan/u);
  });

  it("resolves every replay projection to the hash-free browser view exactly once", () => {
    const vectors = [compiledFirstEveningService.goldenReplay, compiledFirstEveningService.correctiveReplay,
      compiledFirstEveningService.abandonmentReplay];
    for (const vector of vectors) {
      for (const item of vector) {
        const checkpoint = ("response" in item ? (item as { response: { checkpoint: EveningServiceCheckpoint } }).response.checkpoint : item) as EveningServiceCheckpoint;
        const projection = projectEveningService(checkpoint, compiledFirstEveningService.projectionManifest, { disposition: "query", correctiveCueId: null });
        const view = buildBrowserEveningServiceView(checkpoint, projection, "guest");
        expect(JSON.stringify(view)).not.toMatch(/contentManifestHash|artAssetMapHash|serviceHash|replayHash|catalog|checkpoint|digest/u);
        expect(view.facts.every((fact) => fact.text.length > 0)).toBe(true);
        expect(new Set(view.choices.map((choice) => choice.id)).size).toBe(view.choices.length);
      }
    }
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

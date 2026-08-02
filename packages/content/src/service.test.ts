import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectEveningService, type EveningServiceCheckpoint } from "@samurai-sushi/domain/evening-service";
import { canonicalContentJson } from "./hash";
import { compiledFirstEveningService, compileFirstServiceContent, firstEveningServiceCanonicalBytes, firstEveningServiceSource } from "./service";

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
    expect(compiledFirstEveningService.contentManifestHash).toBe("sha256:fed607085d9ca373e996642674d589395507349610e5b614235c250a67fcf75b");
    expect(compiledFirstEveningService.artAssetMapHash).toBe("sha256:9c924461bf9d601c50ea9d8f086c15254dc26bb670a1cb81d253a9f55d8c70ad");
    expect(compiledFirstEveningService.serviceHash).toBe("sha256:1fdaf199ec3d39fe9cb7af084000481e7349f3d96d2aad5b181b316799c0cd7b");
    expect(compiledFirstEveningService.replayHash).toBe("sha256:3b923d2c165153f0c5daec7cbb706f23ac1de848b96b35db241309e45721d3b4");
    expect(compiledFirstEveningService.correctiveReplayHash).toBe("sha256:637e0d17efbd71f702aa2d8b37822e2be117a3e4086e2e41f0cf4deadbe12cb7");
    expect(compiledFirstEveningService.abandonmentReplayHash).toBe("sha256:97d514cbbb507968f6b15151087b58a88b22d3928a2c6356187cb1ec7f375eaa");
    expect(compiledFirstEveningService.terminalReplayHash).toBe("sha256:691656622bcc341186efbee76dbf025013e96150fb38bcc967bcf3782cc269ac");
    expect(createHash("sha256").update(firstEveningServiceCanonicalBytes).digest("hex")).toBe("bff45944f4524daf8cedc57c4b96dfe870e051ffd42a19910bc31608122d81a6");
    expect(Object.isFrozen(compiledFirstEveningService)).toBe(true);
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

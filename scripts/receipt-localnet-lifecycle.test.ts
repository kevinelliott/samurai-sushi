import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./receipt-localnet-lifecycle.ts", import.meta.url), "utf8");

describe("receipt Localnet lifecycle command boundary", () => {
  it("requires immutable candidate/runtime/generation/readiness before the first address-bearing command", () => {
    const candidate = source.indexOf("SAMURAI_RECEIPT_CANDIDATE_COMMIT");
    const runtime = source.indexOf('if (requireSuccess("git", ["rev-parse", "HEAD"], runtimeRoot)');
    const readiness = source.indexOf('["scripts/consumers.mjs", "ready", "samurai-sushi"]');
    const generation = source.indexOf("SAMURAI_RECEIPT_LOCALNET_GENERATION");
    const originate = source.indexOf('"originate", "contract"');
    expect(candidate).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(candidate);
    expect(readiness).toBeGreaterThan(runtime);
    expect(generation).toBeGreaterThan(readiness);
    expect(originate).toBeGreaterThan(generation);
  });

  it("contains no reset, namespace, registration, Shadownet, Mainnet, or wallet command authority", () => {
    expect(source).not.toMatch(/reset --yes|namespace-init|manifest-register|shadownet|mainnet|connect wallet|wallet sdk/i);
    expect(source).toContain('expectedChainId = "NetXtJqPyJGB6Pc"');
    expect(source).toContain('"RECEIPT_NONCE_USED"');
    expect(source).toContain('"RECEIPT_SIGNATURE"');
  });

  it("keeps actual address/operation evidence outside the frozen source worktree", () => {
    expect(source).toContain("Localnet runtime evidence must remain outside the source candidate worktree.");
    expect(source).toContain("source-only-not-originated");
    expect(source).toContain("candidateManifestHash");
    expect(source).toContain("originationOperation");
    expect(source).toContain("acceptedOperation");
  });
});

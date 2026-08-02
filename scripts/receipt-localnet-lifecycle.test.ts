import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./receipt-localnet-lifecycle.ts", import.meta.url), "utf8");

describe("receipt Localnet lifecycle command boundary", () => {
  it("requires immutable candidate/runtime/generation/readiness before the first address-bearing command", () => {
    const candidate = source.indexOf("SAMURAI_RECEIPT_CANDIDATE_COMMIT");
    const runtime = source.indexOf('if (requireSuccess("git", ["rev-parse", "HEAD"], runtimeRoot)');
    const readiness = source.indexOf('["scripts/consumers.mjs", "ready-commit", "samurai-sushi", candidateCommit, RECEIPT_CANDIDATE_MANIFEST_PATH]');
    const generation = source.indexOf("SAMURAI_RECEIPT_LOCALNET_GENERATION");
    const originate = source.indexOf('"originate", "contract"');
    expect(candidate).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(candidate);
    expect(generation).toBeGreaterThan(runtime);
    expect(readiness).toBeGreaterThan(generation);
    expect(originate).toBeGreaterThan(readiness);
  });

  it("cannot treat aggregate or predecessor-only readiness as exact candidate authority", () => {
    expect(source).toContain('"ready-commit", "samurai-sushi", candidateCommit, RECEIPT_CANDIDATE_MANIFEST_PATH');
    expect(source).not.toContain('"ready", "samurai-sushi"');
    expect(source).toContain("withExactCandidateAdmission");
    expect(source).toContain("expectedIdentityId");
    expect(source).toContain("expectedManifestId");
    expect(source).toContain("expectedBlobOid");
    expect(source.indexOf("ready-commit")).toBeLessThan(source.indexOf('"docker"'));
    expect(source.indexOf("ready-commit")).toBeLessThan(source.indexOf('"originate", "contract"'));
  });

  it("contains no reset, namespace, registration, Shadownet, Mainnet, or wallet command authority", () => {
    expect(source).not.toMatch(/reset --yes|namespace-init|manifest-register|shadownet|mainnet|connect wallet|wallet sdk/i);
    expect(source).toContain('expectedChainId = "NetXtJqPyJGB6Pc"');
    expect(source).toContain('"RECEIPT_NONCE_USED"');
    expect(source).toContain('"RECEIPT_SIGNATURE"');
  });

  it("keeps actual address/operation evidence outside the frozen source worktree", () => {
    expect(source).toContain("writeExclusiveExternalEvidenceFile");
    expect(source).toContain("source-only-not-originated");
    expect(source).toContain("candidateManifestHash");
    expect(source).toContain("originationOperation");
    expect(source).toContain("acceptedOperation");
  });

  it("passes confirmation waiting as an Octez global option before address-bearing commands", () => {
    expect(source).toContain('"--wait", "2", "originate", "contract"');
    expect(source).toContain('"--wait", "2", "transfer", "0", "from", "alice"');
    expect(source).not.toContain('"--burn-cap", "6", "--wait"');
    expect(source).not.toContain('"--burn-cap", "1", "--wait"');
  });
});

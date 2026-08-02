import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import candidateManifestInput from "../contracts/receipt/build/deployment-manifest.json" with { type: "json" };
import { parseSourceCandidateDeploymentManifest } from "../packages/receipt-authority/src/deployment-manifest";
import { withExactCandidateAdmission, type ExactCandidateExpectation } from "./receipt-localnet-admission";

const candidateManifest = parseSourceCandidateDeploymentManifest(candidateManifestInput);
const candidateManifestBytes = Buffer.from(`${JSON.stringify(candidateManifestInput, null, 2)}\n`);
const expectation: ExactCandidateExpectation = {
  candidateCommit: "a".repeat(40),
  candidateManifestPath: "contracts/receipt/build/deployment-manifest.json",
  candidateManifestBytes,
  candidateManifest,
  expectedChainId: "NetXtJqPyJGB6Pc",
  expectedGeneration: 3,
  expectedIdentityId: "identity-exact",
  expectedManifestId: "manifest-exact",
  expectedApprovedRef: "refs/remotes/origin/feat/localnet-receipt-authority",
  expectedBlobOid: "b".repeat(40),
};

function validResponse(): Record<string, unknown> {
  return {
    readOnly: true,
    consumer: "samurai-sushi",
    identityId: expectation.expectedIdentityId,
    chainId: expectation.expectedChainId,
    generation: expectation.expectedGeneration,
    manifestId: expectation.expectedManifestId,
    recordedAt: "2026-08-02T10:00:00.000Z",
    evidence: {
      kind: "commit-bound-v1",
      repository: "../samurai-sushi",
      commit: expectation.candidateCommit,
      approvedRef: expectation.expectedApprovedRef,
      approvedRefTip: expectation.candidateCommit,
      sourcePath: expectation.candidateManifestPath,
      blobOid: expectation.expectedBlobOid,
      manifestByteLength: candidateManifestBytes.byteLength,
      manifestSha256: `sha256:${createHash("sha256").update(candidateManifestBytes).digest("hex")}`,
      manifestBytesBase64: candidateManifestBytes.toString("base64"),
    },
    payloadIdentity: { consumer: "samurai-sushi", chainId: expectation.expectedChainId },
    manifest: candidateManifestInput,
  };
}

function assertStopsBeforeEveryAddressEffect(output: string, status = 0): void {
  const effects = Object.fromEntries([
    "docker",
    "artifactCopy",
    "client",
    "origination",
    "addressParse",
    "rpc",
    "evidenceWrite",
  ].map((name) => [name, vi.fn()]));
  expect(() => withExactCandidateAdmission(
    expectation,
    () => ({ status, output }),
    () => {
      for (const effect of Object.values(effects)) effect();
      return undefined;
    },
  )).toThrow();
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
}

describe("exact candidate pre-address admission", () => {
  it("admits only the complete exact response before invoking downstream work", () => {
    const downstream = vi.fn();
    const result = withExactCandidateAdmission(
      expectation,
      () => ({ status: 0, output: JSON.stringify(validResponse()) }),
      (readiness) => { downstream(readiness); return readiness; },
    );
    expect(result).toMatchObject({ manifestId: expectation.expectedManifestId, blobOid: expectation.expectedBlobOid });
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("stops predecessor, absent, identity, generation, manifest, Git, byte, and payload drift before every side effect", () => {
    const mutations: readonly ((value: Record<string, unknown>) => void)[] = [
      (value) => { (value.evidence as Record<string, unknown>).commit = "c".repeat(40); },
      (value) => { delete value.evidence; },
      (value) => { value.identityId = "identity-predecessor"; },
      (value) => { value.generation = 2; },
      (value) => { value.manifestId = "manifest-predecessor"; },
      (value) => { (value.evidence as Record<string, unknown>).sourcePath = "contracts/receipt/build/other.json"; },
      (value) => { (value.evidence as Record<string, unknown>).approvedRef = "refs/remotes/origin/other"; },
      (value) => { (value.evidence as Record<string, unknown>).approvedRefTip = "d".repeat(40); },
      (value) => { (value.evidence as Record<string, unknown>).blobOid = "e".repeat(40); },
      (value) => { (value.evidence as Record<string, unknown>).manifestByteLength = candidateManifestBytes.byteLength + 1; },
      (value) => { (value.evidence as Record<string, unknown>).manifestSha256 = `sha256:${"f".repeat(64)}`; },
      (value) => { (value.evidence as Record<string, unknown>).manifestBytesBase64 = Buffer.from("{}").toString("base64"); },
      (value) => { value.payloadIdentity = { consumer: "dos-esposas", chainId: expectation.expectedChainId }; },
      (value) => { value.manifest = { ...candidateManifestInput, consumer: "dos-esposas" }; },
    ];
    for (const mutate of mutations) {
      const response = validResponse();
      mutate(response);
      assertStopsBeforeEveryAddressEffect(JSON.stringify(response));
    }
  });

  it("stops malformed JSON, duplicate keys, and nonzero ready-commit before every side effect", () => {
    assertStopsBeforeEveryAddressEffect("not-json");
    assertStopsBeforeEveryAddressEffect('{"readOnly":true,"readOnly":true}');
    assertStopsBeforeEveryAddressEffect("runtime unavailable", 1);
  });
});

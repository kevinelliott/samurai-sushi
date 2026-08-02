import { createHash } from "node:crypto";
import { canonicalJson } from "../packages/domain/src/index";
import { parseSourceCandidateDeploymentManifest, type SourceCandidateDeploymentManifestV1 } from "../packages/receipt-authority/src/deployment-manifest";
import { parseStrictJson, strictObject } from "../packages/account-http-runtime/src/strict-json";

export interface InjectedCommandResult {
  readonly status: number;
  readonly output: string;
}

export interface ExactCandidateExpectation {
  readonly candidateCommit: string;
  readonly candidateManifestPath: string;
  readonly candidateManifestBytes: Buffer;
  readonly candidateManifest: SourceCandidateDeploymentManifestV1;
  readonly expectedChainId: string;
  readonly expectedGeneration: number;
  readonly expectedIdentityId: string;
  readonly expectedManifestId: string;
  readonly expectedApprovedRef: string;
  readonly expectedBlobOid: string;
}

export interface ExactCandidateReadiness {
  readonly identityId: string;
  readonly generation: number;
  readonly manifestId: string;
  readonly approvedRef: string;
  readonly approvedRefTip: string;
  readonly blobOid: string;
  readonly candidateManifestSha256: string;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedIdentity(value: unknown, expected: string, label: string): string {
  if (typeof value !== "string" || value !== expected || value.length === 0 || value.length > 256) {
    throw new Error(`Exact readiness ${label} does not match the admitted candidate.`);
  }
  return value;
}

export function validateExactCandidateReadiness(
  responseText: string,
  expected: ExactCandidateExpectation,
): ExactCandidateReadiness {
  const response = strictObject(parseStrictJson(responseText), [
    "chainId",
    "consumer",
    "evidence",
    "generation",
    "identityId",
    "manifest",
    "manifestId",
    "payloadIdentity",
    "readOnly",
    "recordedAt",
  ]);
  const evidence = strictObject(response.evidence, [
    "approvedRef",
    "approvedRefTip",
    "blobOid",
    "commit",
    "kind",
    "manifestByteLength",
    "manifestBytesBase64",
    "manifestSha256",
    "repository",
    "sourcePath",
  ]);
  const payloadIdentity = strictObject(response.payloadIdentity, ["chainId", "consumer"]);
  const manifest = parseSourceCandidateDeploymentManifest(response.manifest);
  const localSha256 = hash(expected.candidateManifestBytes);
  if (
    response.readOnly !== true
    || response.consumer !== "samurai-sushi"
    || response.chainId !== expected.expectedChainId
    || response.generation !== expected.expectedGeneration
    || typeof response.recordedAt !== "string"
    || !Number.isFinite(Date.parse(response.recordedAt))
    || evidence.kind !== "commit-bound-v1"
    || evidence.repository !== "../samurai-sushi"
    || evidence.commit !== expected.candidateCommit
    || evidence.sourcePath !== expected.candidateManifestPath
    || evidence.approvedRef !== expected.expectedApprovedRef
    || evidence.approvedRefTip !== expected.candidateCommit
    || evidence.blobOid !== expected.expectedBlobOid
    || evidence.manifestByteLength !== expected.candidateManifestBytes.byteLength
    || evidence.manifestSha256 !== `sha256:${localSha256}`
    || evidence.manifestBytesBase64 !== expected.candidateManifestBytes.toString("base64")
    || payloadIdentity.consumer !== "samurai-sushi"
    || payloadIdentity.chainId !== expected.expectedChainId
    || canonicalJson(manifest) !== canonicalJson(expected.candidateManifest)
  ) {
    throw new Error("Shared exact readiness did not prove the admitted candidate before address authority.");
  }
  const identityId = boundedIdentity(response.identityId, expected.expectedIdentityId, "identity");
  const manifestId = boundedIdentity(response.manifestId, expected.expectedManifestId, "manifest ID");
  if (!/^[a-f0-9]{40}$/.test(expected.candidateCommit) || !/^[a-f0-9]{40}$/.test(expected.expectedBlobOid)) {
    throw new Error("Exact readiness expectation contains a malformed Git object identity.");
  }
  return Object.freeze({
    identityId,
    generation: expected.expectedGeneration,
    manifestId,
    approvedRef: expected.expectedApprovedRef,
    approvedRefTip: expected.candidateCommit,
    blobOid: expected.expectedBlobOid,
    candidateManifestSha256: localSha256,
  });
}

export function withExactCandidateAdmission<T>(
  expected: ExactCandidateExpectation,
  runReadyCommit: () => InjectedCommandResult,
  afterAdmission: (readiness: ExactCandidateReadiness) => T,
): T {
  const result = runReadyCommit();
  if (result.status !== 0) throw new Error(`Shared ready-commit failed before address authority: ${result.output}`);
  const readiness = validateExactCandidateReadiness(result.output, expected);
  return afterAdmission(readiness);
}

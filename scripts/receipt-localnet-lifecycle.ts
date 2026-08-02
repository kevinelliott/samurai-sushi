import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { blake2b } from "@noble/hashes/blake2b";
import { ed25519 } from "@noble/curves/ed25519";
import { b58Encode, PrefixV2 } from "@taquito/utils";
import { canonicalJson } from "../packages/domain/src/index";
import {
  RECEIPT_AUTHORITY_MANIFEST,
  RECEIPT_AUTHORITY_MANIFEST_HASH,
  RECEIPT_CANDIDATE_MANIFEST_PATH,
  parseGeneratedReceiptSourceBindingModule,
  parseSourceCandidateDeploymentManifest,
  sha256CanonicalJson,
} from "../packages/receipt-authority/src/deployment-manifest";
import { admitSettledReceiptPermit, issueSettledReceiptPermit } from "../packages/receipt-authority/src/server";
import {
  FIXTURE_SETTLED_COMMITMENT_NONCE,
  deterministicSettledCheckpointFixture,
} from "../packages/receipt-authority/src/test-fixture";
import { receiptPermitMichelsonArgument } from "../packages/receipt-authority/src/michelson-argument";
import type { ReceiptAdmissionContext } from "../packages/receipt-authority/src/model";
import { writeExclusiveExternalEvidenceFile } from "./exclusive-evidence-file";
import { withExactCandidateAdmission } from "./receipt-localnet-admission";
import { readRepositoryFile } from "./repository-file";

const root = resolve(process.cwd());
const runtimeRoot = resolve(root, "../project-crypt-tezos-localnet");
const expectedRuntimeCommit = "5edf9cb43af21c06e805eefdcdc0af1291bb789e";
const expectedChainId = "NetXtJqPyJGB6Pc";
const alice = "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb";
const issuerSecret = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex");

interface CommandResult {
  readonly status: number;
  readonly output: string;
}

function command(executable: string, args: readonly string[], cwd = root): CommandResult {
  const result = spawnSync(executable, [...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requireSuccess(executable: string, args: readonly string[], cwd = root): string {
  const result = command(executable, args, cwd);
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed:\n${result.output}`);
  return result.output.trim();
}

function requireFailure(args: readonly string[], expected: RegExp): string {
  const result = command(resolve(runtimeRoot, "scripts/localnet"), ["client", ...args], runtimeRoot);
  if (result.status === 0 || !expected.test(result.output)) {
    throw new Error(`Expected rejected Localnet invocation matching ${expected}, received status ${result.status}:\n${result.output}`);
  }
  return result.output.trim();
}

function client(args: readonly string[]): string {
  return requireSuccess(resolve(runtimeRoot, "scripts/localnet"), ["client", ...args], runtimeRoot);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sign(payloadHash: string): string {
  const tezosDigest = blake2b(Buffer.from(payloadHash, "hex"), { dkLen: 32 });
  return b58Encode(ed25519.sign(tezosDigest, issuerSecret), PrefixV2.Ed25519Signature);
}

function operationHash(output: string, label: string): string {
  const match = output.match(/Operation hash is ['"]?([A-Za-z0-9]{40,60})/i);
  if (!match?.[1]) throw new Error(`${label} did not report an operation hash:\n${output}`);
  return match[1];
}

function contractAddress(output: string): string {
  const match = output.match(/New contract\s+(KT1[1-9A-HJ-NP-Za-km-z]{33})/i);
  if (!match?.[1]) throw new Error(`Origination did not report a contract address:\n${output}`);
  return match[1];
}

async function rpc(path: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:8732${path}`, { cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(`Localnet RPC ${path} failed with HTTP ${response.status}.`);
  return response.json() as Promise<unknown>;
}

function collectEvents(value: unknown, events: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectEvents(entry, events));
    return;
  }
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (row.kind === "event") events.push(row);
  Object.values(row).forEach((entry) => collectEvents(entry, events));
}

async function includedOperation(hash: string): Promise<{ readonly level: number; readonly operation: Record<string, unknown> }> {
  const header = (await rpc("/chains/main/blocks/head/header")) as { level?: unknown };
  if (!Number.isSafeInteger(header.level)) throw new Error("Localnet head level is malformed.");
  for (let offset = 0; offset <= 16; offset += 1) {
    const passes = await rpc(`/chains/main/blocks/head~${offset}/operations/3`);
    if (!Array.isArray(passes)) continue;
    const operation = passes.find(
      (candidate): candidate is Record<string, unknown> =>
        Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as { hash?: unknown }).hash === hash),
    );
    if (operation) return { level: (header.level as number) - offset, operation };
  }
  throw new Error(`Accepted operation ${hash} was not found in the recent canonical Localnet chain.`);
}

const candidateCommit = process.env.SAMURAI_RECEIPT_CANDIDATE_COMMIT ?? "";
if (!/^[a-f0-9]{40}$/.test(candidateCommit)) throw new Error("SAMURAI_RECEIPT_CANDIDATE_COMMIT must be the exact full candidate commit.");
const rawCandidateManifest = readRepositoryFile(root, RECEIPT_CANDIDATE_MANIFEST_PATH);
const candidateManifest = parseSourceCandidateDeploymentManifest(JSON.parse(rawCandidateManifest.toString("utf8")));
const bindingBytes = readRepositoryFile(root, candidateManifest.generatedBindingPath);
if (sha256(bindingBytes) !== candidateManifest.generatedBindingSha256) throw new Error("Receipt source binding bytes drifted before readiness.");
const sourceBinding = parseGeneratedReceiptSourceBindingModule(bindingBytes.toString("utf8"));
if (
  sourceBinding.deploymentClaim !== "source-only-not-originated"
  || sourceBinding.contractAddress !== null
  || sourceBinding.originationOperation !== null
) {
  throw new Error("Receipt source binding contains an impermissible pre-readiness deployment claim.");
}
const head = requireSuccess("git", ["rev-parse", "HEAD"]);
if (head !== candidateCommit) throw new Error(`Candidate commit mismatch: expected ${candidateCommit}, received ${head}.`);
if (requireSuccess("git", ["status", "--porcelain"]) !== "") throw new Error("Receipt Localnet lifecycle requires a clean candidate worktree.");
if (requireSuccess("git", ["rev-parse", "HEAD"], runtimeRoot) !== expectedRuntimeCommit) throw new Error("Shared runtime commit drifted.");
if (requireSuccess("git", ["status", "--porcelain"], runtimeRoot) !== "") throw new Error("Shared runtime worktree is dirty.");
const requestedGeneration = Number(process.env.SAMURAI_RECEIPT_LOCALNET_GENERATION);
if (!Number.isSafeInteger(requestedGeneration)) throw new Error("SAMURAI_RECEIPT_LOCALNET_GENERATION must be the exact generation.");
const expectedIdentityId = process.env.SAMURAI_RECEIPT_LOCALNET_IDENTITY_ID ?? "";
const expectedManifestId = process.env.SAMURAI_RECEIPT_MANIFEST_ID ?? "";
if (!expectedIdentityId || !expectedManifestId) throw new Error("Exact Localnet identity and manifest IDs are required.");
const expectedApprovedRef = "refs/remotes/origin/feat/localnet-receipt-authority";
const expectedBlobOid = requireSuccess("git", ["rev-parse", `${candidateCommit}:${RECEIPT_CANDIDATE_MANIFEST_PATH}`]);
const exactReadiness = withExactCandidateAdmission(
  {
    candidateCommit,
    candidateManifestPath: RECEIPT_CANDIDATE_MANIFEST_PATH,
    candidateManifestBytes: rawCandidateManifest,
    candidateManifest,
    expectedChainId,
    expectedGeneration: requestedGeneration,
    expectedIdentityId,
    expectedManifestId,
    expectedApprovedRef,
    expectedBlobOid,
  },
  () => command(
    "node",
    ["scripts/consumers.mjs", "ready-commit", "samurai-sushi", candidateCommit, RECEIPT_CANDIDATE_MANIFEST_PATH],
    runtimeRoot,
  ),
  (readiness) => readiness,
);
const generation = exactReadiness.generation;
const localManifestSha256 = exactReadiness.candidateManifestSha256;

const health = JSON.parse(requireSuccess(resolve(runtimeRoot, "scripts/localnet"), ["health"], runtimeRoot)) as {
  chain_id?: unknown;
  level?: unknown;
  timestamp?: unknown;
};
if (health.chain_id !== expectedChainId || !Number.isSafeInteger(health.level) || typeof health.timestamp !== "string") {
  throw new Error("Localnet health identity is malformed or foreign.");
}

const composeArgs = ["compose", "--project-directory", runtimeRoot, "-f", resolve(runtimeRoot, "compose.yaml")];
const container = requireSuccess("docker", [...composeArgs, "ps", "-q", "tezos"]);
if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error("Localnet container identity is malformed.");
const alias = `samurai_receipt_g${generation}_l${health.level}`;
const containerArtifact = `/tmp/${alias}.tz`;
const localArtifact = readRepositoryFile(root, candidateManifest.artifact.path);
if (sha256(localArtifact) !== candidateManifest.artifact.sha256) throw new Error("Receipt artifact bytes drifted after exact readiness.");
const localStorage = readRepositoryFile(root, candidateManifest.artifact.storagePath);
if (sha256(localStorage) !== candidateManifest.artifact.storageSha256) throw new Error("Receipt storage bytes drifted after exact readiness.");
requireSuccess("docker", ["cp", resolve(root, candidateManifest.artifact.path), `${container}:${containerArtifact}`]);
const initialStorage = localStorage.toString("utf8").trim();
const originationOutput = client([
  "--wait", "2", "originate", "contract", alias, "transferring", "0", "from", "alice", "running", containerArtifact,
  "--init", initialStorage, "--burn-cap", "6",
]);
const address = contractAddress(originationOutput);
const originationOperation = operationHash(originationOutput, "Origination");

const issuedAt = Math.floor(Date.parse(health.timestamp) / 1000);
if (!Number.isSafeInteger(issuedAt)) throw new Error("Localnet health timestamp is invalid.");
const nonce = sha256(`SAMURAI_SUSHI_LOCALNET_NONCE_V1\n${candidateCommit}\n${generation}\n${address}`);
const settledCheckpoint = deterministicSettledCheckpointFixture();
const permit = issueSettledReceiptPermit({
  checkpoint: settledCheckpoint,
  commitmentNonce: FIXTURE_SETTLED_COMMITMENT_NONCE,
  chainId: expectedChainId,
  owner: alice,
  destination: address,
  nonce,
  issuedAt: issuedAt.toString(),
  expiry: (issuedAt + 900).toString(),
  deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
  issuerKeyId: "localnet-issuer-2026-01",
  issuerPolicyVersion: "1",
}, sign);
const policy = RECEIPT_AUTHORITY_MANIFEST.issuerPolicies[0]!;
const admission: ReceiptAdmissionContext = {
  now: issuedAt.toString(),
  sender: alice,
  chainId: expectedChainId,
  destination: address,
  entrypoint: "submit_receipt",
  attachedMutez: "0",
  deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
  contentVersion: RECEIPT_AUTHORITY_MANIFEST.contentVersion,
  paused: false,
  issuerPolicies: new Map([[policy.keyId, policy]]),
  usedNonces: new Set(),
  usedOwnerCommitments: new Set(),
};
const preSubmissionReceipt = admitSettledReceiptPermit(
  permit,
  admission,
  settledCheckpoint,
  FIXTURE_SETTLED_COMMITMENT_NONCE,
);
const { payload, payloadHash } = permit;
if (
  preSubmissionReceipt.payloadHash !== payloadHash
  || preSubmissionReceipt.serviceCommitment !== payload.serviceCommitment
  || preSubmissionReceipt.contentVersion !== payload.contentVersion
) {
  throw new Error("Server settled-service pre-submission authority drifted.");
}
const serviceCommitment = payload.serviceCommitment;
const argument = receiptPermitMichelsonArgument(permit);
const invocationArgs = [
  "--wait", "2", "transfer", "0", "from", "alice", "to", address, "--entrypoint", "submit_receipt", "--arg", argument,
  "--burn-cap", "1",
];
const acceptedOutput = client(invocationArgs);
const acceptedOperation = operationHash(acceptedOutput, "Accepted receipt invocation");
const duplicateFailure = requireFailure(invocationArgs, /RECEIPT_NONCE_USED/);
const senderFailure = requireFailure(
  ["transfer", "0", "from", "bob", "to", address, "--entrypoint", "submit_receipt", "--arg", argument, "--burn-cap", "1"],
  /RECEIPT_OWNER/,
);
const mutezFailure = requireFailure(
  ["transfer", "1", "from", "alice", "to", address, "--entrypoint", "submit_receipt", "--arg", argument, "--burn-cap", "1"],
  /RECEIPT_NONZERO_MUTEZ/,
);
const badSignaturePermit = { ...permit, signature: sign("ff".repeat(32)) };
const signatureFailure = requireFailure(
  [
    "transfer", "0", "from", "alice", "to", address, "--entrypoint", "submit_receipt",
    "--arg", receiptPermitMichelsonArgument(badSignaturePermit), "--burn-cap", "1",
  ],
  /RECEIPT_SIGNATURE/,
);

const inclusion = await includedOperation(acceptedOperation);
const events: Record<string, unknown>[] = [];
collectEvents(inclusion.operation, events);
const serviceEvents = events.filter((event) => event.tag === "service_receipt");
if (serviceEvents.length !== 1 || !JSON.stringify(serviceEvents[0]).includes(payloadHash)) {
  throw new Error("Accepted Localnet invocation did not emit the exact service_receipt payload hash once.");
}
const storedScript = await rpc(`/chains/main/blocks/head/context/contracts/${address}/script`);
if (!storedScript || typeof storedScript !== "object") throw new Error("Originated receipt contract script is unavailable.");

const evidence = {
  version: 1,
  evidenceKind: "samurai-sushi-localnet-receipt-lifecycle-v1",
  sourceCandidate: {
    commit: candidateCommit,
    manifestId: exactReadiness.manifestId,
    candidateManifestHash: sha256CanonicalJson(candidateManifest),
    candidateManifestSha256: localManifestSha256,
    candidateManifestPath: RECEIPT_CANDIDATE_MANIFEST_PATH,
    approvedRef: exactReadiness.approvedRef,
    approvedRefTip: exactReadiness.approvedRefTip,
    blobOid: exactReadiness.blobOid,
    authorityManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
    artifactSha256: sourceBinding.artifactSha256,
  },
  runtime: { commit: expectedRuntimeCommit, generation, chainId: expectedChainId },
  deployment: { address, originationOperation, acceptedOperation, acceptedLevel: inclusion.level },
  invocation: { owner: alice, payloadHash, serviceCommitment, nonce, event: serviceEvents[0] },
  rejectionProof: {
    duplicate: duplicateFailure.match(/RECEIPT_NONCE_USED[^\n]*/)?.[0] ?? "RECEIPT_NONCE_USED",
    sender: senderFailure.match(/RECEIPT_OWNER[^\n]*/)?.[0] ?? "RECEIPT_OWNER",
    mutez: mutezFailure.match(/RECEIPT_NONZERO_MUTEZ[^\n]*/)?.[0] ?? "RECEIPT_NONZERO_MUTEZ",
    signature: signatureFailure.match(/RECEIPT_SIGNATURE[^\n]*/)?.[0] ?? "RECEIPT_SIGNATURE",
  },
  generatedAt: new Date().toISOString(),
};
const outputPath = resolve(
  process.env.SAMURAI_RECEIPT_EVIDENCE_PATH ?? `/private/tmp/samurai-sushi-receipt-${candidateCommit.slice(0, 12)}-g${generation}.json`,
);
writeExclusiveExternalEvidenceFile(root, outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ ...evidence, evidencePath: outputPath, evidenceSha256: sha256(canonicalJson(evidence)), file: basename(outputPath) }));

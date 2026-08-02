import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { blake2b } from "@noble/hashes/blake2b";
import { ed25519 } from "@noble/curves/ed25519";
import { b58Encode, PrefixV2 } from "@taquito/utils";
import { canonicalJson } from "../packages/domain/src/index";
import { RECEIPT_AUTHORITY_MANIFEST_HASH } from "../packages/receipt-authority/src/deployment-manifest";
import { LOCALNET_RECEIPT_SOURCE_BINDING } from "../packages/receipt-authority/src/generated/localnet-source-binding";
import { receiptPermitMichelsonArgument } from "../packages/receipt-authority/src/michelson-argument";
import { hashReceiptPayload } from "../packages/receipt-authority/src/michelson-pack";
import { parseReceiptPayload, type ReceiptPermitV1 } from "../packages/receipt-authority/src/model";

const root = resolve(process.cwd());
const runtimeRoot = resolve(root, "../project-crypt-tezos-localnet");
const expectedRuntimeCommit = "1d6726650146cbcce292fa7a69f9c227c5465bde";
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
if (
  LOCALNET_RECEIPT_SOURCE_BINDING.deploymentClaim !== "source-only-not-originated"
  || LOCALNET_RECEIPT_SOURCE_BINDING.contractAddress !== null
  || LOCALNET_RECEIPT_SOURCE_BINDING.originationOperation !== null
) {
  throw new Error("Receipt source binding contains an impermissible pre-readiness deployment claim.");
}
const head = requireSuccess("git", ["rev-parse", "HEAD"]);
if (head !== candidateCommit) throw new Error(`Candidate commit mismatch: expected ${candidateCommit}, received ${head}.`);
if (requireSuccess("git", ["status", "--porcelain"]) !== "") throw new Error("Receipt Localnet lifecycle requires a clean candidate worktree.");
if (requireSuccess("git", ["rev-parse", "HEAD"], runtimeRoot) !== expectedRuntimeCommit) throw new Error("Shared runtime commit drifted.");
if (requireSuccess("git", ["status", "--porcelain"], runtimeRoot) !== "") throw new Error("Shared runtime worktree is dirty.");

const ready = JSON.parse(requireSuccess("node", ["scripts/consumers.mjs", "ready", "samurai-sushi"], runtimeRoot)) as {
  namespace?: { generation?: unknown; manifests?: { fresh?: unknown; stale?: unknown } };
};
const generation = ready.namespace?.generation;
const freshManifests = ready.namespace?.manifests?.fresh;
const staleManifests = ready.namespace?.manifests?.stale;
if (
  !Number.isSafeInteger(generation)
  || !Number.isSafeInteger(freshManifests)
  || (freshManifests as number) < 1
  || staleManifests !== 0
) {
  throw new Error("Samurai consumer readiness did not return exclusively fresh current-generation manifest evidence.");
}
const requestedGeneration = Number(process.env.SAMURAI_RECEIPT_LOCALNET_GENERATION);
if (!Number.isSafeInteger(requestedGeneration) || requestedGeneration !== generation) {
  throw new Error(`Localnet generation mismatch: readiness returned ${String(generation)}.`);
}

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
requireSuccess("docker", ["cp", resolve(root, "contracts/receipt/build/samurai_sushi_receipt_v1.tz"), `${container}:${containerArtifact}`]);
const initialStorage = readFileSync(resolve(root, "contracts/receipt/build/samurai_sushi_receipt_v1.storage.tz"), "utf8").trim();
const originationOutput = client([
  "--wait", "2", "originate", "contract", alias, "transferring", "0", "from", "alice", "running", containerArtifact,
  "--init", initialStorage, "--burn-cap", "6",
]);
const address = contractAddress(originationOutput);
const originationOperation = operationHash(originationOutput, "Origination");

const issuedAt = Math.floor(Date.parse(health.timestamp) / 1000);
if (!Number.isSafeInteger(issuedAt)) throw new Error("Localnet health timestamp is invalid.");
const serviceCommitment = sha256(`SAMURAI_SUSHI_LOCALNET_SERVICE_V1\n${candidateCommit}\n${generation}\n${address}`);
const nonce = sha256(`SAMURAI_SUSHI_LOCALNET_NONCE_V1\n${candidateCommit}\n${generation}\n${address}`);
const payload = parseReceiptPayload({
  domain: "SAMURAI_SUSHI_RECEIPT_V1",
  schemaVersion: 1,
  chainId: expectedChainId,
  owner: alice,
  source: alice,
  destination: address,
  entrypoint: "submit_receipt",
  attachedMutez: "0",
  serviceCommitment,
  contentVersion: "phase-1-evening-service-v1",
  nonce,
  issuedAt: issuedAt.toString(),
  expiry: (issuedAt + 900).toString(),
  deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
  issuerKeyId: "localnet-issuer-2026-01",
  issuerPolicyVersion: "1",
});
const payloadHash = hashReceiptPayload(payload);
const permit: ReceiptPermitV1 = { payload, payloadHash, signature: sign(payloadHash) };
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
    candidateManifestHash: LOCALNET_RECEIPT_SOURCE_BINDING.candidateManifestHash,
    authorityManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
    artifactSha256: LOCALNET_RECEIPT_SOURCE_BINDING.artifactSha256,
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
if (!relative(root, outputPath).startsWith("..")) throw new Error("Localnet runtime evidence must remain outside the source candidate worktree.");
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...evidence, evidencePath: outputPath, evidenceSha256: sha256(canonicalJson(evidence)), file: basename(outputPath) }));

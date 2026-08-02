import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../packages/domain/src/index";
import {
  FORBIDDEN_CONTRACT_SURFACE,
  RECEIPT_AUTHORITY_MANIFEST,
  RECEIPT_AUTHORITY_MANIFEST_HASH,
  RECEIPT_CANDIDATE_MANIFEST_PATH,
  parseGeneratedReceiptSourceBindingModule,
  parseReceiptAuthorityManifest,
  parseSourceCandidateDeploymentManifest,
  sha256CanonicalJson,
} from "../packages/receipt-authority/src/deployment-manifest";
import { assertNoReceiptWebContamination } from "./receipt-web-source-scan";
import { readRepositoryFile } from "./repository-file";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyReceiptAuthority(rootInput = process.cwd()): Record<string, unknown> {
const root = resolve(rootInput);
function read(path: string): Buffer {
  return readRepositoryFile(root, path);
}

const rawManifest = read(RECEIPT_CANDIDATE_MANIFEST_PATH);
const manifest = parseSourceCandidateDeploymentManifest(JSON.parse(rawManifest.toString("utf8")));
const rawAuthorityManifest = read(manifest.authorityManifestPath);
if (sha256(rawAuthorityManifest) !== manifest.authorityManifestSha256) throw new Error("Receipt authority manifest byte hash drifted.");
const authorityManifest = parseReceiptAuthorityManifest(JSON.parse(rawAuthorityManifest.toString("utf8")));
if (
  canonicalJson(authorityManifest) !== canonicalJson(RECEIPT_AUTHORITY_MANIFEST)
  || sha256CanonicalJson(authorityManifest) !== RECEIPT_AUTHORITY_MANIFEST_HASH
  || manifest.authorityManifestHash !== RECEIPT_AUTHORITY_MANIFEST_HASH
) {
  throw new Error("Receipt authority manifest policy drifted.");
}

if (sha256(read(manifest.source.path)) !== manifest.source.sha256) throw new Error("Receipt contract source hash drifted.");
if (sha256(read(manifest.artifact.path)) !== manifest.artifact.sha256) throw new Error("Receipt contract artifact hash drifted.");
if (sha256(read(manifest.artifact.storagePath)) !== manifest.artifact.storageSha256) throw new Error("Receipt initial storage hash drifted.");
const rawMicheline = read(manifest.artifact.michelinePath);
if (sha256(rawMicheline) !== manifest.artifact.michelineSha256) throw new Error("Receipt Micheline artifact hash drifted.");

const script = JSON.parse(rawMicheline.toString("utf8")) as unknown;
if (!Array.isArray(script)) throw new Error("Receipt contract artifact is not a Micheline script.");
const parameter = script.find(
  (node): node is { prim: "parameter"; args: [unknown] } =>
    Boolean(node && typeof node === "object" && !Array.isArray(node) && (node as { prim?: unknown }).prim === "parameter"),
);
if (!parameter || !Array.isArray(parameter.args) || parameter.args.length !== 1) throw new Error("Receipt parameter schema is missing.");
if (sha256CanonicalJson(parameter.args[0]) !== manifest.artifact.parameterSchemaSha256) throw new Error("Receipt parameter schema hash drifted.");

const entrypoints = new Set<string>();
function collectEntrypoints(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Receipt parameter branch is malformed.");
  const row = value as Record<string, unknown>;
  if (row.prim === "or") {
    if (!Array.isArray(row.args) || row.args.length !== 2) throw new Error("Receipt parameter union is malformed.");
    row.args.forEach(collectEntrypoints);
    return;
  }
  const annotations = Array.isArray(row.annots) ? row.annots : [];
  const entrypoint = annotations.find((annotation) => typeof annotation === "string" && annotation.startsWith("%"));
  if (typeof entrypoint !== "string") throw new Error("Receipt parameter leaf is missing an entrypoint annotation.");
  entrypoints.add(entrypoint.slice(1));
}
collectEntrypoints(parameter.args[0]);
const expectedEntrypoints = ["revoke_issuer", "set_paused", "submit_receipt"];
if (JSON.stringify([...entrypoints].sort()) !== JSON.stringify(expectedEntrypoints)) {
  throw new Error(`Receipt entrypoint surface drifted: ${[...entrypoints].sort().join(",")}`);
}
for (const forbidden of FORBIDDEN_CONTRACT_SURFACE) {
  if (entrypoints.has(forbidden)) throw new Error(`Receipt contract exposes forbidden ${forbidden} entrypoint.`);
}

const bindingBytes = read(manifest.generatedBindingPath);
if (sha256(bindingBytes) !== manifest.generatedBindingSha256) throw new Error("Generated receipt source binding byte hash drifted.");
const binding = parseGeneratedReceiptSourceBindingModule(bindingBytes.toString("utf8"));
if (
  binding.candidateManifestPath !== RECEIPT_CANDIDATE_MANIFEST_PATH
  || binding.authorityManifestPath !== manifest.authorityManifestPath
  || binding.authorityManifestHash !== manifest.authorityManifestHash
  || binding.authorityManifestSha256 !== manifest.authorityManifestSha256
  || binding.chainId !== manifest.chainId
  || binding.contentVersion !== manifest.contentVersion
  || binding.smartPySourcePath !== manifest.source.path
  || binding.smartPySourceSha256 !== manifest.source.sha256
  || binding.michelsonArtifactPath !== manifest.artifact.path
  || binding.artifactSha256 !== manifest.artifact.sha256
  || binding.michelineArtifactPath !== manifest.artifact.michelinePath
  || binding.michelineSha256 !== manifest.artifact.michelineSha256
  || binding.storagePath !== manifest.artifact.storagePath
  || binding.storageSha256 !== manifest.artifact.storageSha256
  || binding.parameterSchemaSha256 !== manifest.artifact.parameterSchemaSha256
) {
  throw new Error("Generated receipt source binding drifted from the candidate artifact graph.");
}

assertNoReceiptWebContamination(root, ["apps/web/app", "apps/web/public"]);

return {
  manifestPath: RECEIPT_CANDIDATE_MANIFEST_PATH,
  candidateManifestHash: sha256CanonicalJson(manifest),
  candidateManifestSha256: sha256(rawManifest),
  authorityManifestHash: manifest.authorityManifestHash,
  authorityManifestSha256: manifest.authorityManifestSha256,
  generatedBindingSha256: manifest.generatedBindingSha256,
  artifactSha256: manifest.artifact.sha256,
  storageSha256: manifest.artifact.storageSha256,
  parameterSchemaSha256: manifest.artifact.parameterSchemaSha256,
  entrypoints: [...entrypoints].sort(),
  deploymentClaim: manifest.deploymentClaim,
  canonicalManifestBytes: Buffer.byteLength(canonicalJson(manifest)),
};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(verifyReceiptAuthority()));
}

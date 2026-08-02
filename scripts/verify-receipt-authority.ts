import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "../packages/domain/src/index";
import {
  FORBIDDEN_CONTRACT_SURFACE,
  parseSourceCandidateDeploymentManifest,
  sha256CanonicalJson,
} from "../packages/receipt-authority/src/deployment-manifest";
import { LOCALNET_RECEIPT_SOURCE_BINDING } from "../packages/receipt-authority/src/generated/localnet-source-binding";

const root = resolve(process.cwd());
const manifestPath = "contracts/receipt/build/deployment-manifest.json";

function read(path: string): Buffer {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${root}/`) || !statSync(absolute).isFile()) throw new Error(`${path} is not a regular repository file.`);
  return readFileSync(absolute);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const rawManifest = read(manifestPath);
const manifest = parseSourceCandidateDeploymentManifest(JSON.parse(rawManifest.toString("utf8")));
if (sha256(read(manifest.source.path)) !== manifest.source.sha256) throw new Error("Receipt contract source hash drifted.");
if (sha256(read(manifest.artifact.path)) !== manifest.artifact.sha256) throw new Error("Receipt contract artifact hash drifted.");
if (sha256(read(manifest.artifact.storagePath)) !== manifest.artifact.storageSha256) throw new Error("Receipt initial storage hash drifted.");

const artifactJsonPath = manifest.artifact.path.replace(/\.tz$/, ".json");
const script = JSON.parse(read(artifactJsonPath).toString("utf8")) as unknown;
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

const manifestHash = sha256CanonicalJson(manifest);
if (
  LOCALNET_RECEIPT_SOURCE_BINDING.candidateManifestPath !== manifestPath
  || LOCALNET_RECEIPT_SOURCE_BINDING.candidateManifestHash !== manifestHash
  || LOCALNET_RECEIPT_SOURCE_BINDING.authorityManifestHash !== manifest.authorityManifestHash
  || LOCALNET_RECEIPT_SOURCE_BINDING.artifactSha256 !== manifest.artifact.sha256
  || LOCALNET_RECEIPT_SOURCE_BINDING.parameterSchemaSha256 !== manifest.artifact.parameterSchemaSha256
) {
  throw new Error("Generated receipt source binding drifted from the candidate manifest.");
}
if (LOCALNET_RECEIPT_SOURCE_BINDING.contractAddress !== null || LOCALNET_RECEIPT_SOURCE_BINDING.originationOperation !== null) {
  throw new Error("Source-only receipt binding cannot make an address or origination claim.");
}

const webPaths = ["apps/web/app", "apps/web/public"];
for (const webPath of webPaths) {
  const listing = execFileSync("rg", ["--files", webPath], { cwd: root, encoding: "utf8" });
  for (const file of listing.trim().split("\n").filter(Boolean)) {
    const source = read(file).toString("utf8");
    if (/receipt-authority|SAMURAI_SUSHI_RECEIPT_V1|edsk2gM2LioC6Yfk/.test(source)) {
      throw new Error(`Receipt authority or fixture secret crossed into the web source at ${file}.`);
    }
  }
}

console.log(
  JSON.stringify({
    manifestPath,
    manifestSha256: manifestHash,
    authorityManifestSha256: manifest.authorityManifestHash,
    artifactSha256: manifest.artifact.sha256,
    storageSha256: manifest.artifact.storageSha256,
    parameterSchemaSha256: manifest.artifact.parameterSchemaSha256,
    entrypoints: [...entrypoints].sort(),
    deploymentClaim: manifest.deploymentClaim,
    canonicalManifestBytes: Buffer.byteLength(canonicalJson(manifest)),
  }),
);

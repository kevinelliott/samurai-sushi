import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { ed25519 } from "@noble/curves/ed25519";
import { b58Encode, PrefixV2 } from "@taquito/utils";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { canonicalJson } from "../packages/domain/src/index";
import {
  FORBIDDEN_CONTRACT_SURFACE,
  RECEIPT_AUTHORITY_MANIFEST_PATH,
  RECEIPT_AUTHORITY_MANIFEST,
  RECEIPT_AUTHORITY_MANIFEST_HASH,
  RECEIPT_CANDIDATE_MANIFEST_PATH,
  RECEIPT_MICHELINE_ARTIFACT_PATH,
  RECEIPT_MICHELSON_ARTIFACT_PATH,
  RECEIPT_SMARTPY_SOURCE_PATH,
  RECEIPT_SOURCE_BINDING_PATH,
  RECEIPT_STORAGE_PATH,
  parseReceiptAuthorityManifest,
  parseSourceCandidateDeploymentManifest,
  sha256CanonicalJson,
} from "../packages/receipt-authority/src/deployment-manifest";
import { issueSettledReceiptPermit } from "../packages/receipt-authority/src/server";
import { receiptPayloadPackedHex } from "../packages/receipt-authority/src/michelson-pack";
import {
  FIXTURE_SETTLED_COMMITMENT_NONCE,
  deterministicSettledCheckpointFixture,
} from "../packages/receipt-authority/src/test-fixture";
import {
  PUBLIC_RECEIPT_RECORD_KEYS,
  SERVICE_RECEIPT_EVENT_KEYS,
} from "../packages/receipt-authority/src/model";
import { readRepositoryFile, writeRepositoryFile } from "./repository-file";

const root = resolve(process.cwd());
const fixturePath = "packages/receipt-authority/fixtures/receipt-permit-v1.json";
const fixtureIssuerSecret = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex");

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function read(path: string): Buffer {
  return readRepositoryFile(root, path);
}

function write(path: string, bytes: Uint8Array | string): void {
  writeRepositoryFile(root, path, bytes);
}

const authorityManifestBytes = read(RECEIPT_AUTHORITY_MANIFEST_PATH);
const authorityManifest = parseReceiptAuthorityManifest(JSON.parse(authorityManifestBytes.toString("utf8")));
if (canonicalJson(authorityManifest) !== canonicalJson(RECEIPT_AUTHORITY_MANIFEST)) {
  throw new Error("Receipt authority manifest bytes drifted from the canonical policy.");
}
const authorityManifestSha256 = sha256(authorityManifestBytes);

function compileSmartPy(): void {
  const python = process.env.SMARTPY_PYTHON ?? "/private/tmp/dos-esposas-smartpy/bin/python";
  const scratch = mkdtempSync(join(tmpdir(), "samurai-sushi-receipt-compile-"));
  try {
    execFileSync(python, [resolve(root, RECEIPT_SMARTPY_SOURCE_PATH)], { cwd: scratch, stdio: "inherit" });
    const output = join(scratch, "samurai_sushi_receipt_v1");
    for (const [sourceName, targetPath] of [
      ["step_001_cont_0_contract.tz", RECEIPT_MICHELSON_ARTIFACT_PATH],
      ["step_001_cont_0_contract.json", RECEIPT_MICHELINE_ARTIFACT_PATH],
      ["step_001_cont_0_storage.tz", RECEIPT_STORAGE_PATH],
    ] as const) {
      const source = join(output, sourceName);
      const status = lstatSync(source);
      if (status.isSymbolicLink() || !status.isFile()) throw new Error(`SmartPy output ${sourceName} is not one regular file.`);
      write(targetPath, readFileSync(source));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parameterSchemaHash(): string {
  const contract = JSON.parse(read(RECEIPT_MICHELINE_ARTIFACT_PATH).toString("utf8")) as unknown;
  if (!Array.isArray(contract)) throw new Error("SmartPy contract artifact must be a Micheline script array.");
  const parameter = contract.find(
    (node): node is { prim: "parameter"; args: [unknown] } =>
      Boolean(node && typeof node === "object" && !Array.isArray(node) && (node as { prim?: unknown }).prim === "parameter"),
  );
  if (!parameter || !Array.isArray(parameter.args) || parameter.args.length !== 1) {
    throw new Error("SmartPy contract artifact is missing its exact parameter schema.");
  }
  return sha256CanonicalJson(parameter.args[0]);
}

function fixtureSignature(payloadHash: string): string {
  const tezosDigest = blake2b(Buffer.from(payloadHash, "hex"), { dkLen: 32 });
  return b58Encode(ed25519.sign(tezosDigest, fixtureIssuerSecret), PrefixV2.Ed25519Signature);
}

function writeGoldenVector(): void {
  const permit = issueSettledReceiptPermit(
    {
      checkpoint: deterministicSettledCheckpointFixture(),
      commitmentNonce: FIXTURE_SETTLED_COMMITMENT_NONCE,
      chainId: authorityManifest.chainId,
      owner: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb",
      destination: "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton",
      nonce: "22".repeat(32),
      issuedAt: "1770000000",
      expiry: "1770000900",
      deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
      issuerKeyId: "localnet-issuer-2026-01",
      issuerPolicyVersion: "1",
    },
    fixtureSignature,
  );
  write(fixturePath, `${JSON.stringify({
    schemaVersion: 1,
    payload: permit.payload,
    packedHex: receiptPayloadPackedHex(permit.payload),
    payloadHash: permit.payloadHash,
    signature: permit.signature,
  }, null, 2)}\n`);
}

writeGoldenVector();
compileSmartPy();

const bindingObject = {
  version: 1,
  deploymentClaim: "source-only-not-originated",
  candidateManifestPath: RECEIPT_CANDIDATE_MANIFEST_PATH,
  authorityManifestPath: RECEIPT_AUTHORITY_MANIFEST_PATH,
  authorityManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
  authorityManifestSha256,
  chainId: authorityManifest.chainId,
  profile: authorityManifest.profile,
  contractName: authorityManifest.contractName,
  entrypoint: authorityManifest.entrypoint,
  contentVersion: authorityManifest.contentVersion,
  contractAddress: null,
  originationOperation: null,
  smartPySourcePath: RECEIPT_SMARTPY_SOURCE_PATH,
  smartPySourceSha256: sha256(read(RECEIPT_SMARTPY_SOURCE_PATH)),
  michelsonArtifactPath: RECEIPT_MICHELSON_ARTIFACT_PATH,
  artifactSha256: sha256(read(RECEIPT_MICHELSON_ARTIFACT_PATH)),
  michelineArtifactPath: RECEIPT_MICHELINE_ARTIFACT_PATH,
  michelineSha256: sha256(read(RECEIPT_MICHELINE_ARTIFACT_PATH)),
  storagePath: RECEIPT_STORAGE_PATH,
  storageSha256: sha256(read(RECEIPT_STORAGE_PATH)),
  parameterSchemaSha256: parameterSchemaHash(),
} as const;
const binding = `// Generated by scripts/build-receipt-authority.ts. Do not edit.\n`
  + `export const LOCALNET_RECEIPT_SOURCE_BINDING = ${JSON.stringify(bindingObject, null, 2)} as const;\n`;
write(RECEIPT_SOURCE_BINDING_PATH, binding);

const manifest = parseSourceCandidateDeploymentManifest({
  version: 1,
  schemaVersion: 1,
  kind: "samurai-sushi-receipt-source-candidate-v1",
  consumer: "samurai-sushi",
  chainId: authorityManifest.chainId,
  profile: "localnet",
  deploymentClaim: "source-only-not-originated",
  contractName: authorityManifest.contractName,
  entrypoint: authorityManifest.entrypoint,
  contentVersion: authorityManifest.contentVersion,
  authorityManifestPath: RECEIPT_AUTHORITY_MANIFEST_PATH,
  authorityManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
  authorityManifestSha256,
  source: { path: RECEIPT_SMARTPY_SOURCE_PATH, sha256: bindingObject.smartPySourceSha256 },
  artifact: {
    path: RECEIPT_MICHELSON_ARTIFACT_PATH,
    sha256: bindingObject.artifactSha256,
    storagePath: RECEIPT_STORAGE_PATH,
    storageSha256: bindingObject.storageSha256,
    michelinePath: RECEIPT_MICHELINE_ARTIFACT_PATH,
    michelineSha256: bindingObject.michelineSha256,
    parameterSchemaSha256: bindingObject.parameterSchemaSha256,
  },
  generatedBindingPath: RECEIPT_SOURCE_BINDING_PATH,
  generatedBindingSha256: sha256(read(RECEIPT_SOURCE_BINDING_PATH)),
  confirmationThreshold: authorityManifest.confirmationThreshold,
  finalityPolicy: authorityManifest.finalityPolicy,
  publicStorageKeys: PUBLIC_RECEIPT_RECORD_KEYS,
  publicEventKeys: SERVICE_RECEIPT_EVENT_KEYS,
  forbiddenContractSurface: FORBIDDEN_CONTRACT_SURFACE,
  claimBoundary: "authorized-permit-acceptance-only",
});

write(RECEIPT_CANDIDATE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
const candidateManifestHash = sha256CanonicalJson(manifest);

console.log(
  JSON.stringify({
    authorityManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
    candidateManifestHash,
    sourceSha256: manifest.source.sha256,
    artifactSha256: manifest.artifact.sha256,
    storageSha256: manifest.artifact.storageSha256,
    parameterSchemaSha256: manifest.artifact.parameterSchemaSha256,
    manifestPath: relative(root, resolve(root, RECEIPT_CANDIDATE_MANIFEST_PATH)),
    deploymentClaim: manifest.deploymentClaim,
    canonicalManifestBytes: Buffer.byteLength(canonicalJson(manifest)),
  }),
);

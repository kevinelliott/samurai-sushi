import { createHash } from "node:crypto";
import { canonicalJson } from "@samurai-sushi/domain";
import { FIRST_EVENING_CONTENT_VERSION } from "@samurai-sushi/domain/evening-service";
import {
  PUBLIC_RECEIPT_RECORD_KEYS,
  RECEIPT_DOMAIN,
  RECEIPT_ENTRYPOINT,
  SERVICE_RECEIPT_EVENT_KEYS,
  parseIssuerKeyPolicy,
  type IssuerKeyPolicyV1,
} from "./model";

const HASH = /^[a-f0-9]{64}$/;
const LOCALNET_CHAIN_ID = "NetXtJqPyJGB6Pc";
const LOCALNET_ADMINISTRATOR = "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb";
const LOCALNET_FINALITY_POLICY = "localnet-two-confirmation-rehearsal-v1";

export const RECEIPT_AUTHORITY_MANIFEST_PATH = "contracts/receipt/authority-manifest.json" as const;
export const RECEIPT_CANDIDATE_MANIFEST_PATH = "contracts/receipt/build/deployment-manifest.json" as const;
export const RECEIPT_SMARTPY_SOURCE_PATH = "contracts/receipt/samurai_sushi_receipt.py" as const;
export const RECEIPT_MICHELSON_ARTIFACT_PATH = "contracts/receipt/build/samurai_sushi_receipt_v1.tz" as const;
export const RECEIPT_MICHELINE_ARTIFACT_PATH = "contracts/receipt/build/samurai_sushi_receipt_v1.json" as const;
export const RECEIPT_STORAGE_PATH = "contracts/receipt/build/samurai_sushi_receipt_v1.storage.tz" as const;
export const RECEIPT_SOURCE_BINDING_PATH = "packages/receipt-authority/src/generated/localnet-source-binding.ts" as const;

export const FORBIDDEN_CONTRACT_SURFACE = Object.freeze([
  "approval",
  "balance",
  "burn",
  "currency",
  "delegate",
  "der",
  "economic",
  "fa2",
  "marketplace",
  "metadata-mutation",
  "migrate",
  "operator",
  "random",
  "referral",
  "reward",
  "transfer",
] as const);

export interface ReceiptAuthorityManifestV1 {
  readonly version: 1;
  readonly schemaVersion: 1;
  readonly consumer: "samurai-sushi";
  readonly chainId: string;
  readonly profile: "localnet";
  readonly contractName: typeof RECEIPT_DOMAIN;
  readonly entrypoint: typeof RECEIPT_ENTRYPOINT;
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
  readonly sourceAdministrator: string;
  readonly pauseController: string;
  readonly maximumPermitLifetimeSeconds: 900;
  readonly maxClockSkewSeconds: 30;
  readonly confirmationThreshold: number;
  readonly finalityPolicy: string;
  readonly issuerPolicies: readonly IssuerKeyPolicyV1[];
}

export interface SourceCandidateDeploymentManifestV1 {
  readonly version: 1;
  readonly schemaVersion: 1;
  readonly kind: "samurai-sushi-receipt-source-candidate-v1";
  readonly consumer: "samurai-sushi";
  readonly chainId: string;
  readonly profile: "localnet";
  readonly deploymentClaim: "source-only-not-originated";
  readonly contractName: typeof RECEIPT_DOMAIN;
  readonly entrypoint: typeof RECEIPT_ENTRYPOINT;
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
  readonly authorityManifestPath: string;
  readonly authorityManifestHash: string;
  readonly authorityManifestSha256: string;
  readonly source: Readonly<{ path: string; sha256: string }>;
  readonly artifact: Readonly<{
    path: string;
    sha256: string;
    storagePath: string;
    storageSha256: string;
    michelinePath: string;
    michelineSha256: string;
    parameterSchemaSha256: string;
  }>;
  readonly generatedBindingPath: string;
  readonly generatedBindingSha256: string;
  readonly confirmationThreshold: number;
  readonly finalityPolicy: string;
  readonly publicStorageKeys: readonly string[];
  readonly publicEventKeys: readonly string[];
  readonly forbiddenContractSurface: readonly string[];
  readonly claimBoundary: "authorized-permit-acceptance-only";
}

export interface LocalnetReceiptSourceBindingV1 {
  readonly version: 1;
  readonly deploymentClaim: "source-only-not-originated";
  readonly candidateManifestPath: typeof RECEIPT_CANDIDATE_MANIFEST_PATH;
  readonly authorityManifestPath: typeof RECEIPT_AUTHORITY_MANIFEST_PATH;
  readonly authorityManifestHash: string;
  readonly authorityManifestSha256: string;
  readonly chainId: string;
  readonly profile: "localnet";
  readonly contractName: typeof RECEIPT_DOMAIN;
  readonly entrypoint: typeof RECEIPT_ENTRYPOINT;
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
  readonly contractAddress: null;
  readonly originationOperation: null;
  readonly smartPySourcePath: typeof RECEIPT_SMARTPY_SOURCE_PATH;
  readonly smartPySourceSha256: string;
  readonly michelsonArtifactPath: typeof RECEIPT_MICHELSON_ARTIFACT_PATH;
  readonly artifactSha256: string;
  readonly michelineArtifactPath: typeof RECEIPT_MICHELINE_ARTIFACT_PATH;
  readonly michelineSha256: string;
  readonly storagePath: typeof RECEIPT_STORAGE_PATH;
  readonly storageSha256: string;
  readonly parameterSchemaSha256: string;
}

function object(input: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const names = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new TypeError(`${label} has an unexpected field set.`);
  }
  return input as Record<string, unknown>;
}

function string(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 256) throw new TypeError(`${label} is invalid.`);
  return input;
}

function natural(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) throw new TypeError(`${label} is invalid.`);
  return input as number;
}

function hash(input: unknown, label: string): string {
  const value = string(input, label);
  if (!HASH.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function exactStringArray(input: unknown, expected: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(input) || input.length !== expected.length || input.some((value, index) => value !== expected[index])) {
    throw new TypeError(`${label} does not match the canonical set.`);
  }
  return Object.freeze([...expected]);
}

export function sha256CanonicalJson(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

export function parseReceiptAuthorityManifest(input: unknown): ReceiptAuthorityManifestV1 {
  const row = object(
    input,
    [
      "chainId",
      "confirmationThreshold",
      "consumer",
      "contentVersion",
      "contractName",
      "entrypoint",
      "finalityPolicy",
      "issuerPolicies",
      "maxClockSkewSeconds",
      "maximumPermitLifetimeSeconds",
      "pauseController",
      "profile",
      "schemaVersion",
      "sourceAdministrator",
      "version",
    ],
    "receipt authority manifest",
  );
  if (!Array.isArray(row.issuerPolicies) || row.issuerPolicies.length === 0) throw new TypeError("receipt authority manifest issuer policies are required.");
  const policies = row.issuerPolicies.map(parseIssuerKeyPolicy);
  if (new Set(policies.map((policy) => policy.keyId)).size !== policies.length) throw new TypeError("receipt authority issuer key IDs must be unique.");
  const result: ReceiptAuthorityManifestV1 = {
    version: row.version === 1 ? 1 : fail("receipt authority manifest version is unsupported."),
    schemaVersion: row.schemaVersion === 1 ? 1 : fail("receipt authority schema version is unsupported."),
    consumer: row.consumer === "samurai-sushi" ? "samurai-sushi" : fail("receipt authority consumer is invalid."),
    chainId: row.chainId === LOCALNET_CHAIN_ID ? LOCALNET_CHAIN_ID : fail("receipt authority chain ID is invalid."),
    profile: row.profile === "localnet" ? "localnet" : fail("receipt authority profile is invalid."),
    contractName: row.contractName === RECEIPT_DOMAIN ? RECEIPT_DOMAIN : fail("receipt authority contract name is invalid."),
    entrypoint: row.entrypoint === RECEIPT_ENTRYPOINT ? RECEIPT_ENTRYPOINT : fail("receipt authority entrypoint is invalid."),
    contentVersion:
      row.contentVersion === FIRST_EVENING_CONTENT_VERSION
        ? FIRST_EVENING_CONTENT_VERSION
        : fail("receipt authority content version is invalid."),
    sourceAdministrator:
      row.sourceAdministrator === LOCALNET_ADMINISTRATOR
        ? LOCALNET_ADMINISTRATOR
        : fail("receipt authority administrator is invalid."),
    pauseController:
      row.pauseController === LOCALNET_ADMINISTRATOR
        ? LOCALNET_ADMINISTRATOR
        : fail("receipt authority pause controller is invalid."),
    maximumPermitLifetimeSeconds:
      row.maximumPermitLifetimeSeconds === 900 ? 900 : fail("receipt authority maximum lifetime is invalid."),
    maxClockSkewSeconds: row.maxClockSkewSeconds === 30 ? 30 : fail("receipt authority clock skew is invalid."),
    confirmationThreshold:
      row.confirmationThreshold === 2 ? 2 : fail("receipt authority confirmation threshold is invalid."),
    finalityPolicy:
      row.finalityPolicy === LOCALNET_FINALITY_POLICY
        ? LOCALNET_FINALITY_POLICY
        : fail("receipt authority finality policy is invalid."),
    issuerPolicies: Object.freeze(policies),
  };
  return Object.freeze(result);
}

function fail(message: string): never {
  throw new TypeError(message);
}

export const RECEIPT_AUTHORITY_MANIFEST = parseReceiptAuthorityManifest({
  chainId: LOCALNET_CHAIN_ID,
  confirmationThreshold: 2,
  consumer: "samurai-sushi",
  contentVersion: FIRST_EVENING_CONTENT_VERSION,
  contractName: RECEIPT_DOMAIN,
  entrypoint: RECEIPT_ENTRYPOINT,
  finalityPolicy: LOCALNET_FINALITY_POLICY,
  issuerPolicies: [{
    activatesAt: "1767225600",
    keyId: "localnet-issuer-2026-01",
    policyVersion: "1",
    publicKey: "edpkuZpp81M8NmaFbueXY8bk7EP9V54XTnwsFFt77Z5FTPs2QzLU9r",
    retiresAt: "2051222400",
    revoked: false,
    verifyUntil: "2051223300",
  }],
  maxClockSkewSeconds: 30,
  maximumPermitLifetimeSeconds: 900,
  pauseController: LOCALNET_ADMINISTRATOR,
  profile: "localnet",
  schemaVersion: 1,
  sourceAdministrator: LOCALNET_ADMINISTRATOR,
  version: 1,
});
export const RECEIPT_AUTHORITY_MANIFEST_HASH = sha256CanonicalJson(RECEIPT_AUTHORITY_MANIFEST);

export function parseSourceCandidateDeploymentManifest(input: unknown): SourceCandidateDeploymentManifestV1 {
  const row = object(
    input,
    [
      "artifact",
      "authorityManifestHash",
      "authorityManifestPath",
      "authorityManifestSha256",
      "chainId",
      "claimBoundary",
      "confirmationThreshold",
      "consumer",
      "contentVersion",
      "contractName",
      "deploymentClaim",
      "entrypoint",
      "finalityPolicy",
      "forbiddenContractSurface",
      "generatedBindingPath",
      "generatedBindingSha256",
      "kind",
      "profile",
      "publicEventKeys",
      "publicStorageKeys",
      "schemaVersion",
      "source",
      "version",
    ],
    "source candidate deployment manifest",
  );
  const source = object(row.source, ["path", "sha256"], "source candidate contract source");
  const artifact = object(
    row.artifact,
    ["michelinePath", "michelineSha256", "parameterSchemaSha256", "path", "sha256", "storagePath", "storageSha256"],
    "source candidate contract artifact",
  );
  const result: SourceCandidateDeploymentManifestV1 = {
    version: row.version === 1 ? 1 : fail("source candidate manifest version is unsupported."),
    schemaVersion: row.schemaVersion === 1 ? 1 : fail("source candidate schema version is unsupported."),
    kind:
      row.kind === "samurai-sushi-receipt-source-candidate-v1"
        ? "samurai-sushi-receipt-source-candidate-v1"
        : fail("source candidate kind is invalid."),
    consumer: row.consumer === "samurai-sushi" ? "samurai-sushi" : fail("source candidate consumer is invalid."),
    chainId: string(row.chainId, "source candidate chain ID"),
    profile: row.profile === "localnet" ? "localnet" : fail("source candidate profile is invalid."),
    deploymentClaim:
      row.deploymentClaim === "source-only-not-originated"
        ? "source-only-not-originated"
        : fail("source candidate deployment claim is invalid."),
    contractName: row.contractName === RECEIPT_DOMAIN ? RECEIPT_DOMAIN : fail("source candidate contract is invalid."),
    entrypoint: row.entrypoint === RECEIPT_ENTRYPOINT ? RECEIPT_ENTRYPOINT : fail("source candidate entrypoint is invalid."),
    contentVersion:
      row.contentVersion === FIRST_EVENING_CONTENT_VERSION
        ? FIRST_EVENING_CONTENT_VERSION
        : fail("source candidate content version is invalid."),
    authorityManifestPath:
      row.authorityManifestPath === RECEIPT_AUTHORITY_MANIFEST_PATH
        ? RECEIPT_AUTHORITY_MANIFEST_PATH
        : fail("source candidate authority manifest path is invalid."),
    authorityManifestHash: hash(row.authorityManifestHash, "source candidate authority manifest hash"),
    authorityManifestSha256: hash(row.authorityManifestSha256, "source candidate authority manifest byte hash"),
    source: Object.freeze({
      path:
        source.path === RECEIPT_SMARTPY_SOURCE_PATH
          ? RECEIPT_SMARTPY_SOURCE_PATH
          : fail("source candidate SmartPy source path is invalid."),
      sha256: hash(source.sha256, "source candidate source hash"),
    }),
    artifact: Object.freeze({
      path:
        artifact.path === RECEIPT_MICHELSON_ARTIFACT_PATH
          ? RECEIPT_MICHELSON_ARTIFACT_PATH
          : fail("source candidate Michelson path is invalid."),
      sha256: hash(artifact.sha256, "source candidate artifact hash"),
      storagePath:
        artifact.storagePath === RECEIPT_STORAGE_PATH
          ? RECEIPT_STORAGE_PATH
          : fail("source candidate storage path is invalid."),
      storageSha256: hash(artifact.storageSha256, "source candidate storage hash"),
      michelinePath:
        artifact.michelinePath === RECEIPT_MICHELINE_ARTIFACT_PATH
          ? RECEIPT_MICHELINE_ARTIFACT_PATH
          : fail("source candidate Micheline path is invalid."),
      michelineSha256: hash(artifact.michelineSha256, "source candidate Micheline hash"),
      parameterSchemaSha256: hash(artifact.parameterSchemaSha256, "source candidate parameter schema hash"),
    }),
    generatedBindingPath:
      row.generatedBindingPath === RECEIPT_SOURCE_BINDING_PATH
        ? RECEIPT_SOURCE_BINDING_PATH
        : fail("source candidate generated binding path is invalid."),
    generatedBindingSha256: hash(row.generatedBindingSha256, "source candidate generated binding hash"),
    confirmationThreshold: natural(row.confirmationThreshold, "source candidate confirmation threshold"),
    finalityPolicy: string(row.finalityPolicy, "source candidate finality policy"),
    publicStorageKeys: exactStringArray(row.publicStorageKeys, PUBLIC_RECEIPT_RECORD_KEYS, "source candidate public storage keys"),
    publicEventKeys: exactStringArray(row.publicEventKeys, SERVICE_RECEIPT_EVENT_KEYS, "source candidate event keys"),
    forbiddenContractSurface: exactStringArray(row.forbiddenContractSurface, FORBIDDEN_CONTRACT_SURFACE, "source candidate forbidden surface"),
    claimBoundary:
      row.claimBoundary === "authorized-permit-acceptance-only"
        ? "authorized-permit-acceptance-only"
        : fail("source candidate claim boundary is invalid."),
  };
  if (
    result.chainId !== RECEIPT_AUTHORITY_MANIFEST.chainId
    || result.contentVersion !== RECEIPT_AUTHORITY_MANIFEST.contentVersion
    || result.authorityManifestHash !== RECEIPT_AUTHORITY_MANIFEST_HASH
  ) {
    fail("source candidate authority identity does not match the canonical manifest.");
  }
  if (
    result.confirmationThreshold !== RECEIPT_AUTHORITY_MANIFEST.confirmationThreshold
    || result.finalityPolicy !== RECEIPT_AUTHORITY_MANIFEST.finalityPolicy
  ) {
    fail("source candidate finality policy does not match the authority manifest.");
  }
  return Object.freeze(result);
}

export function parseLocalnetReceiptSourceBinding(input: unknown): LocalnetReceiptSourceBindingV1 {
  const row = object(input, [
    "artifactSha256",
    "authorityManifestHash",
    "authorityManifestPath",
    "authorityManifestSha256",
    "candidateManifestPath",
    "chainId",
    "contentVersion",
    "contractAddress",
    "contractName",
    "deploymentClaim",
    "entrypoint",
    "michelineArtifactPath",
    "michelineSha256",
    "michelsonArtifactPath",
    "originationOperation",
    "parameterSchemaSha256",
    "profile",
    "smartPySourcePath",
    "smartPySourceSha256",
    "storagePath",
    "storageSha256",
    "version",
  ], "Localnet receipt source binding");
  const result: LocalnetReceiptSourceBindingV1 = {
    version: row.version === 1 ? 1 : fail("Localnet receipt source binding version is invalid."),
    deploymentClaim:
      row.deploymentClaim === "source-only-not-originated"
        ? "source-only-not-originated"
        : fail("Localnet receipt source binding claim is invalid."),
    candidateManifestPath:
      row.candidateManifestPath === RECEIPT_CANDIDATE_MANIFEST_PATH
        ? RECEIPT_CANDIDATE_MANIFEST_PATH
        : fail("Localnet receipt candidate manifest path is invalid."),
    authorityManifestPath:
      row.authorityManifestPath === RECEIPT_AUTHORITY_MANIFEST_PATH
        ? RECEIPT_AUTHORITY_MANIFEST_PATH
        : fail("Localnet receipt authority manifest path is invalid."),
    authorityManifestHash: hash(row.authorityManifestHash, "Localnet receipt authority manifest hash"),
    authorityManifestSha256: hash(row.authorityManifestSha256, "Localnet receipt authority manifest byte hash"),
    chainId: string(row.chainId, "Localnet receipt chain ID"),
    profile: row.profile === "localnet" ? "localnet" : fail("Localnet receipt profile is invalid."),
    contractName: row.contractName === RECEIPT_DOMAIN ? RECEIPT_DOMAIN : fail("Localnet receipt contract is invalid."),
    entrypoint: row.entrypoint === RECEIPT_ENTRYPOINT ? RECEIPT_ENTRYPOINT : fail("Localnet receipt entrypoint is invalid."),
    contentVersion:
      row.contentVersion === FIRST_EVENING_CONTENT_VERSION
        ? FIRST_EVENING_CONTENT_VERSION
        : fail("Localnet receipt content version is invalid."),
    contractAddress: row.contractAddress === null ? null : fail("Localnet receipt binding cannot contain an address."),
    originationOperation:
      row.originationOperation === null ? null : fail("Localnet receipt binding cannot contain an origination operation."),
    smartPySourcePath:
      row.smartPySourcePath === RECEIPT_SMARTPY_SOURCE_PATH
        ? RECEIPT_SMARTPY_SOURCE_PATH
        : fail("Localnet receipt SmartPy path is invalid."),
    smartPySourceSha256: hash(row.smartPySourceSha256, "Localnet receipt SmartPy hash"),
    michelsonArtifactPath:
      row.michelsonArtifactPath === RECEIPT_MICHELSON_ARTIFACT_PATH
        ? RECEIPT_MICHELSON_ARTIFACT_PATH
        : fail("Localnet receipt Michelson path is invalid."),
    artifactSha256: hash(row.artifactSha256, "Localnet receipt Michelson hash"),
    michelineArtifactPath:
      row.michelineArtifactPath === RECEIPT_MICHELINE_ARTIFACT_PATH
        ? RECEIPT_MICHELINE_ARTIFACT_PATH
        : fail("Localnet receipt Micheline path is invalid."),
    michelineSha256: hash(row.michelineSha256, "Localnet receipt Micheline hash"),
    storagePath:
      row.storagePath === RECEIPT_STORAGE_PATH
        ? RECEIPT_STORAGE_PATH
        : fail("Localnet receipt storage path is invalid."),
    storageSha256: hash(row.storageSha256, "Localnet receipt storage hash"),
    parameterSchemaSha256: hash(row.parameterSchemaSha256, "Localnet receipt parameter schema hash"),
  };
  if (
    result.authorityManifestHash !== RECEIPT_AUTHORITY_MANIFEST_HASH
    || result.chainId !== RECEIPT_AUTHORITY_MANIFEST.chainId
    || result.contentVersion !== RECEIPT_AUTHORITY_MANIFEST.contentVersion
  ) {
    fail("Localnet receipt binding authority identity drifted.");
  }
  return Object.freeze(result);
}

export function parseGeneratedReceiptSourceBindingModule(source: string): LocalnetReceiptSourceBindingV1 {
  const prefix = "// Generated by scripts/build-receipt-authority.ts. Do not edit.\nexport const LOCALNET_RECEIPT_SOURCE_BINDING = ";
  const suffix = " as const;\n";
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) {
    throw new TypeError("Generated receipt source binding has a noncanonical module wrapper.");
  }
  return parseLocalnetReceiptSourceBinding(JSON.parse(source.slice(prefix.length, -suffix.length)));
}

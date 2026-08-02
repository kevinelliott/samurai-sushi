import { createHash } from "node:crypto";
import { canonicalJson } from "@samurai-sushi/domain";
import authorityManifestInput from "../../../contracts/receipt/authority-manifest.json" with { type: "json" };
import {
  PUBLIC_RECEIPT_RECORD_KEYS,
  RECEIPT_DOMAIN,
  RECEIPT_ENTRYPOINT,
  SERVICE_RECEIPT_EVENT_KEYS,
  parseIssuerKeyPolicy,
  type IssuerKeyPolicyV1,
} from "./model";

const HASH = /^[a-f0-9]{64}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/(?:|$))(?!.*\\)[a-zA-Z0-9._/-]+$/;
const LOCALNET_CHAIN_ID = "NetXtJqPyJGB6Pc";
const LOCALNET_ADMINISTRATOR = "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb";
const LOCALNET_FINALITY_POLICY = "localnet-two-confirmation-rehearsal-v1";

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
  readonly authorityManifestPath: string;
  readonly authorityManifestHash: string;
  readonly source: Readonly<{ path: string; sha256: string }>;
  readonly artifact: Readonly<{
    path: string;
    sha256: string;
    storagePath: string;
    storageSha256: string;
    parameterSchemaSha256: string;
  }>;
  readonly generatedBindingPath: string;
  readonly confirmationThreshold: number;
  readonly finalityPolicy: string;
  readonly publicStorageKeys: readonly string[];
  readonly publicEventKeys: readonly string[];
  readonly forbiddenContractSurface: readonly string[];
  readonly claimBoundary: "authorized-permit-acceptance-only";
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

function path(input: unknown, label: string): string {
  const value = string(input, label);
  if (!PATH.test(value) || value.includes("//") || value.endsWith("/")) throw new TypeError(`${label} must be a safe repository-relative path.`);
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

export const RECEIPT_AUTHORITY_MANIFEST = parseReceiptAuthorityManifest(authorityManifestInput);
export const RECEIPT_AUTHORITY_MANIFEST_HASH = sha256CanonicalJson(authorityManifestInput);

export function parseSourceCandidateDeploymentManifest(input: unknown): SourceCandidateDeploymentManifestV1 {
  const row = object(
    input,
    [
      "artifact",
      "authorityManifestHash",
      "authorityManifestPath",
      "chainId",
      "claimBoundary",
      "confirmationThreshold",
      "consumer",
      "contractName",
      "deploymentClaim",
      "entrypoint",
      "finalityPolicy",
      "forbiddenContractSurface",
      "generatedBindingPath",
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
    ["parameterSchemaSha256", "path", "sha256", "storagePath", "storageSha256"],
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
    authorityManifestPath: path(row.authorityManifestPath, "source candidate authority manifest path"),
    authorityManifestHash: hash(row.authorityManifestHash, "source candidate authority manifest hash"),
    source: Object.freeze({ path: path(source.path, "source candidate source path"), sha256: hash(source.sha256, "source candidate source hash") }),
    artifact: Object.freeze({
      path: path(artifact.path, "source candidate artifact path"),
      sha256: hash(artifact.sha256, "source candidate artifact hash"),
      storagePath: path(artifact.storagePath, "source candidate storage path"),
      storageSha256: hash(artifact.storageSha256, "source candidate storage hash"),
      parameterSchemaSha256: hash(artifact.parameterSchemaSha256, "source candidate parameter schema hash"),
    }),
    generatedBindingPath: path(row.generatedBindingPath, "source candidate generated binding path"),
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
  if (result.chainId !== RECEIPT_AUTHORITY_MANIFEST.chainId || result.authorityManifestHash !== RECEIPT_AUTHORITY_MANIFEST_HASH) {
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

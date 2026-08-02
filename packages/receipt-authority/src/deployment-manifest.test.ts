import { describe, expect, it } from "vitest";
import candidateInput from "../../../contracts/receipt/build/deployment-manifest.json" with { type: "json" };
import authorityInput from "../../../contracts/receipt/authority-manifest.json" with { type: "json" };
import { LOCALNET_RECEIPT_SOURCE_BINDING } from "./generated/localnet-source-binding";
import {
  FORBIDDEN_CONTRACT_SURFACE,
  RECEIPT_AUTHORITY_MANIFEST,
  RECEIPT_AUTHORITY_MANIFEST_HASH,
  parseReceiptAuthorityManifest,
  parseSourceCandidateDeploymentManifest,
  sha256CanonicalJson,
} from "./deployment-manifest";

describe("receipt authority deployment manifests", () => {
  it("pins the exact Localnet policy identity and source-only generated binding", () => {
    expect(parseReceiptAuthorityManifest(authorityInput)).toStrictEqual(RECEIPT_AUTHORITY_MANIFEST);
    expect(RECEIPT_AUTHORITY_MANIFEST_HASH).toBe("9fa3874f00d4cce18de80d579c5be8f8ae970b33257c33ed15c2e2cd80937833");
    const candidate = parseSourceCandidateDeploymentManifest(candidateInput);
    expect(sha256CanonicalJson(candidate)).toBe(LOCALNET_RECEIPT_SOURCE_BINDING.candidateManifestHash);
    expect(candidate.deploymentClaim).toBe("source-only-not-originated");
    expect(LOCALNET_RECEIPT_SOURCE_BINDING).toMatchObject({ contractAddress: null, originationOperation: null });
    expect(candidate.forbiddenContractSurface).toEqual(FORBIDDEN_CONTRACT_SURFACE);
  });

  it("rejects manifest, chain, profile, source, artifact, schema, finality, public fact, and economic-surface drift", () => {
    const mutations: readonly [string, unknown][] = [
      ["foreign consumer", { ...candidateInput, consumer: "dos-esposas" }],
      ["foreign chain", { ...candidateInput, chainId: "NetXdQprcVkpaWU" }],
      ["foreign profile", { ...candidateInput, profile: "shadownet" }],
      ["deployment claim", { ...candidateInput, deploymentClaim: "originated" }],
      ["manifest hash", { ...candidateInput, authorityManifestHash: "00".repeat(32) }],
      ["source traversal", { ...candidateInput, source: { ...candidateInput.source, path: "../foreign.py" } }],
      ["source hash", { ...candidateInput, source: { ...candidateInput.source, sha256: "x".repeat(64) } }],
      ["artifact hash", { ...candidateInput, artifact: { ...candidateInput.artifact, sha256: "AA".repeat(32) } }],
      ["schema hash", { ...candidateInput, artifact: { ...candidateInput.artifact, parameterSchemaSha256: "z".repeat(64) } }],
      ["entrypoint", { ...candidateInput, entrypoint: "transfer" }],
      ["finality", { ...candidateInput, finalityPolicy: "submitted-is-final" }],
      ["confirmations", { ...candidateInput, confirmationThreshold: 0 }],
      ["public storage", { ...candidateInput, publicStorageKeys: [...candidateInput.publicStorageKeys, "score"] }],
      ["public event", { ...candidateInput, publicEventKeys: [...candidateInput.publicEventKeys, "dialogue"] }],
      ["economic surface", { ...candidateInput, forbiddenContractSurface: FORBIDDEN_CONTRACT_SURFACE.slice(1) }],
      ["address claim", { ...candidateInput, contractAddress: "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton" }],
    ];
    for (const [label, mutation] of mutations) expect(() => parseSourceCandidateDeploymentManifest(mutation), label).toThrow();
  });

  it("rejects Localnet authority drift in chain, roles, lifetime, skew, confirmations, finality, and issuer policy shape", () => {
    const mutations: readonly [string, unknown][] = [
      ["chain", { ...authorityInput, chainId: "NetXdQprcVkpaWU" }],
      ["administrator", { ...authorityInput, sourceAdministrator: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6" }],
      ["pause controller", { ...authorityInput, pauseController: "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6" }],
      ["lifetime", { ...authorityInput, maximumPermitLifetimeSeconds: 901 }],
      ["skew", { ...authorityInput, maxClockSkewSeconds: 31 }],
      ["confirmations", { ...authorityInput, confirmationThreshold: 1 }],
      ["finality", { ...authorityInput, finalityPolicy: "submitted-is-final" }],
      ["policy duplicate", { ...authorityInput, issuerPolicies: [authorityInput.issuerPolicies[0], authorityInput.issuerPolicies[0]] }],
      [
        "policy window",
        { ...authorityInput, issuerPolicies: [{ ...authorityInput.issuerPolicies[0], retiresAt: "1767225599" }] },
      ],
    ];
    for (const [label, mutation] of mutations) expect(() => parseReceiptAuthorityManifest(mutation), label).toThrow();
  });

  it("does not claim ownership, rarity, value, progression, or independently verified private service facts", () => {
    const { forbiddenContractSurface: _forbidden, ...claimBearingManifest } = candidateInput;
    const publicManifest = JSON.stringify(claimBearingManifest);
    expect(publicManifest).not.toMatch(/one-of-one|rare|scarce|exclusive|edition|ownership|authorship|skill|score|reward|price|value|progression/i);
    expect(candidateInput.claimBoundary).toBe("authorized-permit-acceptance-only");
  });
});

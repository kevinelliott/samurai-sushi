import { describe, expect, it } from "vitest";
import candidateInput from "../../../contracts/receipt/build/deployment-manifest.json" with { type: "json" };
import authorityInput from "../../../contracts/receipt/authority-manifest.json" with { type: "json" };
import { LOCALNET_RECEIPT_SOURCE_BINDING } from "./generated/localnet-source-binding";
import {
  FORBIDDEN_CONTRACT_SURFACE,
  RECEIPT_AUTHORITY_MANIFEST,
  RECEIPT_AUTHORITY_MANIFEST_HASH,
  parseLocalnetReceiptSourceBinding,
  parseReceiptAuthorityManifest,
  parseSourceCandidateDeploymentManifest,
  sha256CanonicalJson,
} from "./deployment-manifest";

describe("receipt authority deployment manifests", () => {
  it("pins the exact Localnet policy identity and source-only generated binding", () => {
    expect(parseReceiptAuthorityManifest(authorityInput)).toStrictEqual(RECEIPT_AUTHORITY_MANIFEST);
    expect(RECEIPT_AUTHORITY_MANIFEST_HASH).toBe("3d6e4cf1e3ee898a6c6106e790f909f73d4e12c01d073a7f0e3c59011c4daa79");
    const candidate = parseSourceCandidateDeploymentManifest(candidateInput);
    expect(sha256CanonicalJson(candidate)).toBe("f6d7281593a71905c5fec82efc10377b47af509632fc2564dcc2de1578ad1c38");
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
      ["manifest byte hash", { ...candidateInput, authorityManifestSha256: "x".repeat(64) }],
      ["authority manifest safe wrong path", { ...candidateInput, authorityManifestPath: "docs/LOCALNET_RECEIPT_AUTHORITY.md" }],
      ["source traversal", { ...candidateInput, source: { ...candidateInput.source, path: "../foreign.py" } }],
      ["source safe wrong path", { ...candidateInput, source: { ...candidateInput.source, path: "README.md" } }],
      ["source hash", { ...candidateInput, source: { ...candidateInput.source, sha256: "x".repeat(64) } }],
      ["Michelson safe wrong path", { ...candidateInput, artifact: { ...candidateInput.artifact, path: "README.md" } }],
      ["artifact hash", { ...candidateInput, artifact: { ...candidateInput.artifact, sha256: "AA".repeat(32) } }],
      ["Micheline safe wrong path", { ...candidateInput, artifact: { ...candidateInput.artifact, michelinePath: "package.json" } }],
      ["storage safe wrong path", { ...candidateInput, artifact: { ...candidateInput.artifact, storagePath: "README.md" } }],
      ["schema hash", { ...candidateInput, artifact: { ...candidateInput.artifact, parameterSchemaSha256: "z".repeat(64) } }],
      ["binding safe wrong path", { ...candidateInput, generatedBindingPath: "README.md" }],
      ["binding hash", { ...candidateInput, generatedBindingSha256: "x".repeat(64) }],
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

  it("rejects every wrong-but-safe path in the generated binding graph", () => {
    expect(parseLocalnetReceiptSourceBinding(LOCALNET_RECEIPT_SOURCE_BINDING)).toEqual(LOCALNET_RECEIPT_SOURCE_BINDING);
    const mutations: readonly [string, Record<string, unknown>][] = [
      ["candidate", { candidateManifestPath: "README.md" }],
      ["authority", { authorityManifestPath: "README.md" }],
      ["source", { smartPySourcePath: "README.md" }],
      ["Michelson", { michelsonArtifactPath: "README.md" }],
      ["Micheline", { michelineArtifactPath: "package.json" }],
      ["storage", { storagePath: "README.md" }],
    ];
    for (const [label, mutation] of mutations) {
      expect(() => parseLocalnetReceiptSourceBinding({ ...LOCALNET_RECEIPT_SOURCE_BINDING, ...mutation }), label).toThrow(/path/);
    }
  });

  it("rejects Localnet authority drift in chain, roles, lifetime, skew, confirmations, finality, and issuer policy shape", () => {
    const mutations: readonly [string, unknown][] = [
      ["chain", { ...authorityInput, chainId: "NetXdQprcVkpaWU" }],
      ["content version", { ...authorityInput, contentVersion: "phase-1-evening-service-v999" }],
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

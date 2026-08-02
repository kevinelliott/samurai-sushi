import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import candidateInput from "../contracts/receipt/build/deployment-manifest.json" with { type: "json" };
import { RECEIPT_CANDIDATE_MANIFEST_PATH } from "../packages/receipt-authority/src/deployment-manifest";
import { verifyReceiptAuthority } from "./verify-receipt-authority";

const projectRoot = resolve(import.meta.dirname, "..");

function fixture(): string {
  const root = mkdtempSync("/tmp/ssrv-");
  const paths = [
    RECEIPT_CANDIDATE_MANIFEST_PATH,
    candidateInput.authorityManifestPath,
    candidateInput.generatedBindingPath,
    candidateInput.source.path,
    candidateInput.artifact.path,
    candidateInput.artifact.michelinePath,
    candidateInput.artifact.storagePath,
  ];
  for (const path of paths) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    cpSync(resolve(projectRoot, path), resolve(root, path));
  }
  mkdirSync(resolve(root, "apps/web/app"), { recursive: true });
  mkdirSync(resolve(root, "apps/web/public"), { recursive: true });
  return realpathSync(root);
}

function writeCandidate(root: string, mutation: Record<string, unknown>): void {
  writeFileSync(resolve(root, RECEIPT_CANDIDATE_MANIFEST_PATH), `${JSON.stringify({ ...candidateInput, ...mutation }, null, 2)}\n`);
}

describe("receipt authority artifact-graph verifier", () => {
  it("accepts the exact canonical path and byte graph", () => {
    expect(verifyReceiptAuthority(fixture())).toMatchObject({ deploymentClaim: "source-only-not-originated" });
  });

  it("rejects authority-manifest and generated-binding byte digest substitutions", () => {
    const authority = fixture();
    writeCandidate(authority, { authorityManifestSha256: "00".repeat(32) });
    expect(() => verifyReceiptAuthority(authority)).toThrow(/authority manifest byte hash drifted/);

    const binding = fixture();
    writeCandidate(binding, { generatedBindingSha256: "11".repeat(32) });
    expect(() => verifyReceiptAuthority(binding)).toThrow(/source binding byte hash drifted/);
  });

  it("rejects in-repository, escaping, and unsupported source referents before a source claim", () => {
    const inRepository = fixture();
    const source = resolve(inRepository, candidateInput.source.path);
    const sibling = resolve(inRepository, "contracts/receipt/sibling.py");
    writeFileSync(sibling, readFileSync(source));
    rmSync(source);
    symlinkSync(sibling, source);
    expect(() => verifyReceiptAuthority(inRepository)).toThrow(/regular repository file|symbolic link/);

    const escaping = fixture();
    const escapingSource = resolve(escaping, candidateInput.source.path);
    rmSync(escapingSource);
    symlinkSync(resolve(projectRoot, candidateInput.source.path), escapingSource);
    expect(() => verifyReceiptAuthority(escaping)).toThrow(/regular repository file|symbolic link/);

    const unsupported = fixture();
    const unsupportedSource = resolve(unsupported, candidateInput.source.path);
    rmSync(unsupportedSource);
    mkdirSync(unsupportedSource);
    expect(() => verifyReceiptAuthority(unsupported)).toThrow(/regular repository file/);
  });
});

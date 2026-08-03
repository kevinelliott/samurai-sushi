import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const RECEIPT_WEB_CONTAMINATION = /receipt-authority(?:\/server)?|edsk2gM2LioC6Yfk|issueSettledReceiptPermit|admitSettledReceiptPermit|deriveSettledServiceReceiptFacts|FIXTURE_SETTLED_COMMITMENT_NONCE|deterministicSettledCheckpointFixture|commitmentNonce|commitmentPreimage|issuerSignature|executablePermit|workerToken|leaseGeneration|SAMURAI_SUSHI_SERVICE_COMMITMENT_V1|challenge_id|player_session_id|credential_id|wallet_link_id|proof_hash|proof_request_hash|rawProvider(?:Payload|Error)?|providerErrorText|requestSignPayload|requestOperation|sendOperations|injectOperation|broadcastOperation|buildContractCall|estimateNetworkFee|ObserveOperation/;

function repositoryPath(root: string, absolute: string): string {
  const path = relative(root, absolute);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || resolve(root, path) !== absolute) {
    throw new Error(`Web source scan escaped the repository root at ${absolute}.`);
  }
  return path.split(sep).join("/");
}

function walk(root: string, absolute: string, files: string[]): void {
  const path = repositoryPath(root, absolute);
  const status = lstatSync(absolute);
  if (status.isSymbolicLink()) throw new Error(`Web source scan rejects symbolic link ${path}.`);
  if (status.isFile()) {
    files.push(path);
    return;
  }
  if (!status.isDirectory()) throw new Error(`Web source scan rejects unsupported filesystem entry ${path}.`);
  for (const name of readdirSync(absolute).sort()) {
    walk(root, resolve(absolute, name), files);
  }
}

export function deterministicRegularFiles(root: string, sourceRoots: readonly string[]): readonly string[] {
  const repositoryRoot = resolve(root);
  const files: string[] = [];
  for (const sourceRoot of sourceRoots) {
    if (sourceRoot === "" || sourceRoot.startsWith("/") || sourceRoot.split("/").includes("..")) {
      throw new Error(`Web source scan root is unsafe: ${sourceRoot}.`);
    }
    walk(repositoryRoot, resolve(repositoryRoot, sourceRoot), files);
  }
  return files.sort();
}

export function assertNoReceiptWebContamination(root: string, sourceRoots: readonly string[]): readonly string[] {
  const files = deterministicRegularFiles(root, sourceRoots);
  for (const file of files) {
    const source = readFileSync(resolve(root, file), "utf8");
    if (RECEIPT_WEB_CONTAMINATION.test(source)) {
      throw new Error(`Receipt authority or fixture secret crossed into the web source at ${file}.`);
    }
  }
  return files;
}

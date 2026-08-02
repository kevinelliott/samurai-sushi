/* global fetch, process, setTimeout */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const pin = JSON.parse(await readFile(resolve(projectRoot, ".tezos-runtime.json"), "utf8"));
const profiles = {
  localnet: {
    network: "localnet",
    rpcUrl: "http://127.0.0.1:8732",
    chainId: "NetXtJqPyJGB6Pc",
    indexerUrl: "",
  },
  shadownet: {
    network: "shadownet",
    rpcUrl: "https://rpc.shadownet.teztnets.com",
    chainId: "NetXsqzbfFenSTS",
    indexerUrl: "https://api.shadownet.tzkt.io",
  },
};

function environment(profile, extra = {}) {
  return {
    ...process.env,
    TEZOS_NETWORK: profile.network,
    TEZOS_RPC_URL: profile.rpcUrl,
    TEZOS_CHAIN_ID: profile.chainId,
    TEZOS_INDEXER_URL: profile.indexerUrl,
    NEXT_PUBLIC_TEZOS_NETWORK: profile.network,
    NEXT_PUBLIC_TEZOS_RPC_URL: profile.rpcUrl,
    NEXT_PUBLIC_TEZOS_CHAIN_ID: profile.chainId,
    NEXT_PUBLIC_TEZOS_INDEXER_URL: profile.indexerUrl,
    SAMURAI_TEZOS_RUNTIME_REVISION: pin.revision,
    NEXT_TELEMETRY_DISABLED: "1",
    ...extra,
  };
}

function run(args, profile) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("pnpm", args, { cwd: projectRoot, env: environment(profile), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Command exited from signal ${signal}.`));
      else if (code !== 0) reject(new Error(`pnpm ${args.join(" ")} exited ${code}.`));
      else resolveRun();
    });
  });
}

async function waitForHtml(port) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return response.text();
      lastError = new Error(`Server returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw lastError ?? new Error("Production server did not become ready.");
}

async function startAndAssert(profile, port) {
  const child = spawn("pnpm", ["start:raw"], {
    cwd: projectRoot,
    env: environment(profile, { PORT: String(port) }),
    stdio: "inherit",
  });
  try {
    const html = await waitForHtml(port);
    assert.match(html, /Counter Ledger/i);
    for (const hidden of [profiles.localnet.network, profiles.shadownet.network,
      profiles.localnet.chainId, profiles.shadownet.chainId, profiles.localnet.rpcUrl,
      profiles.shadownet.rpcUrl, profiles.shadownet.indexerUrl, pin.revision]) {
      assert.doesNotMatch(html, new RegExp(hidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
}

async function assertNoReceiptPrivateInputsInBrowserArtifacts() {
  const staticRoot = resolve(projectRoot, "apps/web/.next/static");
  const appRoot = resolve(projectRoot, "apps/web/.next/server/app");
  const staticFiles = (await readdir(staticRoot, { recursive: true }))
    .filter((file) => /\.(?:js|map)$/u.test(file));
  const appFiles = (await readdir(appRoot, { recursive: true }))
    .filter((file) => /\.(?:html|rsc|txt)$/u.test(file));
  const output = (await Promise.all([
    ...staticFiles.map((file) => readFile(resolve(staticRoot, file), "utf8")),
    ...appFiles.map((file) => readFile(resolve(appRoot, file), "utf8")),
  ])).join("\n");
  for (const marker of [
    "@samurai-sushi/receipt-authority/server",
    "issueSettledReceiptPermit",
    "admitSettledReceiptPermit",
    "deriveSettledServiceReceiptFacts",
    "FIXTURE_SETTLED_COMMITMENT_NONCE",
    "deterministicSettledCheckpointFixture",
    "commitmentNonce",
    "SAMURAI_SUSHI_SERVICE_COMMITMENT_V1",
    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    "edsk2gM2LioC6Yfk",
  ]) {
    assert.doesNotMatch(output, new RegExp(marker, "u"));
  }
}

await run(["build:raw"], profiles.localnet);
await assertNoReceiptPrivateInputsInBrowserArtifacts();
await startAndAssert(profiles.shadownet, 3111);
await run(["build:raw"], profiles.shadownet);
await assertNoReceiptPrivateInputsInBrowserArtifacts();
await startAndAssert(profiles.localnet, 3112);

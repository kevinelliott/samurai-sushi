import { describe, expect, it } from "vitest";
import { createDeterministicWalletRuntime, normalizeWalletRuntime } from "./runtime";
import { INITIAL_WALLET_LINK_SNAPSHOT, reduceWalletLink } from "./state-machine";

const runtime = Object.freeze({ providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc",
  account: "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb", permissionScopes: ["account"] as const });

describe("wallet runtime authority", () => {
  it("strictly normalizes exact capability-poor facts and rejects provider extras", () => {
    expect(normalizeWalletRuntime(runtime)).toEqual(runtime);
    expect(() => normalizeWalletRuntime({ ...runtime, signer: () => undefined })).toThrow(/unavailable/);
    expect(() => normalizeWalletRuntime({ ...runtime, permissionScopes: ["account", "account"] })).toThrow(/unavailable/);
  });

  it("generation-fences delayed results and detects same-coordinate changed bytes", () => {
    const first = reduceWalletLink(INITIAL_WALLET_LINK_SNAPSHOT, { kind: "CONNECT" }).next;
    const disconnected = reduceWalletLink(first, { kind: "DISCONNECT" }).next;
    const second = reduceWalletLink(disconnected, { kind: "CONNECT" }).next;
    expect(reduceWalletLink(second, { kind: "RESULT", generation: first.generation,
      expectedSessionRevision: first.sessionRevision, state: "PERMISSIONED", runtime, normalizedDigest: "a".repeat(64) }).disposition).toBe("STALE");
    const applied = reduceWalletLink(second, { kind: "RESULT", generation: second.generation,
      expectedSessionRevision: second.sessionRevision, state: "PERMISSIONED", runtime, normalizedDigest: "b".repeat(64) }).next;
    expect(reduceWalletLink(applied, { kind: "RESULT", generation: applied.generation,
      expectedSessionRevision: applied.sessionRevision, state: "LINKED_EXISTING", runtime, normalizedDigest: "c".repeat(64) }).disposition).toBe("CONTRADICTION");
  });

  it("keeps every forbidden transport tripwire at zero", async () => {
    const fake = createDeterministicWalletRuntime(runtime);
    await fake.port.requestPermission();
    await fake.port.readNormalizedRuntime();
    await fake.port.disconnect();
    expect(fake.tripwires()).toEqual({ permission: 1, read: 1, disconnect: 1, sign: 0, send: 0,
      inject: 0, broadcast: 0, contract: 0, fee: 0, observe: 0 });
  });
});

const CHAIN_ID = /^Net[1-9A-HJ-NP-Za-km-z]{12}$/;
const ACCOUNT = /^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/;
const PROVIDERS = Object.freeze(["localnet-wallet", "deterministic-wallet"] as const);

export const WALLET_PERMISSION_SCOPES = Object.freeze(["account"] as const);
export type WalletPermissionScope = typeof WALLET_PERMISSION_SCOPES[number];

export interface NormalizedWalletRuntime {
  readonly providerId: typeof PROVIDERS[number];
  readonly chainId: string;
  readonly account: string;
  readonly permissionScopes: readonly WalletPermissionScope[];
}

import { WALLET_REVIEW_COPY, type WalletReviewCopy } from "./presentation";

export type WalletPermissionResult = Readonly<{
  status: "PERMISSIONED";
  runtime: NormalizedWalletRuntime;
  presentation: WalletReviewCopy;
}> | Readonly<{
  status: "CANCELLED" | "REJECTED" | "UNAVAILABLE";
  presentation: WalletReviewCopy;
}>;

export type WalletRuntimeChange = Readonly<{ status: "RUNTIME"; runtime: NormalizedWalletRuntime }>
  | Readonly<{ status: "DISCONNECTED" | "PERMISSION_CHANGED" | "UNAVAILABLE"; presentation: WalletReviewCopy }>;

export interface WalletRuntimePort {
  requestPermission(): Promise<WalletPermissionResult>;
  readNormalizedRuntime(): Promise<NormalizedWalletRuntime>;
  subscribeNormalizedRuntimeChanges(listener: (change: WalletRuntimeChange) => void): () => void;
  disconnect(): Promise<void>;
}

function invalid(): never { throw new TypeError("Wallet runtime facts are unavailable."); }

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) invalid();
  for (const name of names) if (!descriptors[name]?.enumerable || !("value" in descriptors[name]!)) invalid();
  return Object.fromEntries(names.map((name) => [name, descriptors[name]!.value]));
}

function text(value: unknown, pattern: RegExp, maximum = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) invalid();
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function normalizeWalletRuntime(value: unknown): NormalizedWalletRuntime {
  const row = exactObject(value, ["providerId", "chainId", "account", "permissionScopes"]);
  if (!Array.isArray(row.permissionScopes) || row.permissionScopes.length !== 1
    || row.permissionScopes[0] !== "account") invalid();
  return deepFreeze({
    providerId: (() => { const provider = text(row.providerId, /^[a-z][a-z0-9-]*$/, 64);
      if (!PROVIDERS.includes(provider as typeof PROVIDERS[number])) invalid(); return provider as typeof PROVIDERS[number]; })(),
    chainId: text(row.chainId, CHAIN_ID, 15),
    account: text(row.account, ACCOUNT, 36),
    permissionScopes: ["account"] as const,
  });
}

export function normalizeWalletPermissionResult(value: unknown): WalletPermissionResult {
  if (value && typeof value === "object" && !Array.isArray(value)
    && Object.getOwnPropertyNames(value).length === 1 && Object.getOwnPropertyNames(value)[0] === "status") {
    const status = exactObject(value, ["status"]).status;
    if (status === "CANCELLED") return Object.freeze({ status, presentation: WALLET_REVIEW_COPY["wallet.access.cancelled"] });
    if (status === "REJECTED") return Object.freeze({ status, presentation: WALLET_REVIEW_COPY["wallet.access.rejected"] });
    if (status === "UNAVAILABLE") return Object.freeze({ status, presentation: WALLET_REVIEW_COPY["wallet.access.unavailable"] });
    invalid();
  }
  return Object.freeze({ status: "PERMISSIONED", runtime: normalizeWalletRuntime(value),
    presentation: WALLET_REVIEW_COPY["wallet.access.connected"] });
}

export function normalizeWalletRuntimeChange(value: unknown): WalletRuntimeChange {
  if (value && typeof value === "object" && !Array.isArray(value)
    && Object.getOwnPropertyNames(value).length === 1 && Object.getOwnPropertyNames(value)[0] === "status") {
    const status = exactObject(value, ["status"]).status;
    if (status === "DISCONNECTED") return Object.freeze({ status, presentation: WALLET_REVIEW_COPY["wallet.access.disconnected"] });
    if (status === "PERMISSION_CHANGED") return Object.freeze({ status, presentation: WALLET_REVIEW_COPY["wallet.access.permission-changed"] });
    if (status === "UNAVAILABLE") return Object.freeze({ status, presentation: WALLET_REVIEW_COPY["wallet.access.unavailable"] });
    invalid();
  }
  return Object.freeze({ status: "RUNTIME", runtime: normalizeWalletRuntime(value) });
}

export function runtimeDriftPresentation(expected: NormalizedWalletRuntime, actual: NormalizedWalletRuntime): WalletReviewCopy | null {
  if (actual.providerId !== expected.providerId) return WALLET_REVIEW_COPY["wallet.access.provider-changed"];
  if (actual.chainId !== expected.chainId) return WALLET_REVIEW_COPY["wallet.access.wrong-network"];
  if (actual.account !== expected.account) return WALLET_REVIEW_COPY["wallet.access.account-changed"];
  if (actual.permissionScopes.length !== 1 || actual.permissionScopes[0] !== "account") return WALLET_REVIEW_COPY["wallet.access.permission-changed"];
  return null;
}

/**
 * A deliberately capability-poor Localnet adapter. The supplied bridge may
 * return permission/runtime facts only; no signer, transport, RPC, or wallet
 * client can cross this port.
 */
export function createLocalnetWalletRuntimePort(bridge: Readonly<{
  requestPermission: () => Promise<unknown>;
  readRuntime: () => Promise<unknown>;
  subscribe: (listener: (value: unknown) => void) => () => void;
  disconnect: () => Promise<void>;
}>): WalletRuntimePort {
  const exact = exactObject(bridge, ["requestPermission", "readRuntime", "subscribe", "disconnect"]);
  for (const value of Object.values(exact)) if (typeof value !== "function") invalid();
  return Object.freeze({
    requestPermission: async () => {
      try { return normalizeWalletPermissionResult(await bridge.requestPermission()); }
      catch { return Object.freeze({ status: "UNAVAILABLE", presentation: WALLET_REVIEW_COPY["wallet.access.unavailable"] }); }
    },
    readNormalizedRuntime: async () => normalizeWalletRuntime(await bridge.readRuntime()),
    subscribeNormalizedRuntimeChanges: (listener: (change: WalletRuntimeChange) => void) => bridge.subscribe((value) => {
      try { listener(normalizeWalletRuntimeChange(value)); }
      catch { listener(Object.freeze({ status: "UNAVAILABLE", presentation: WALLET_REVIEW_COPY["wallet.access.unavailable"] })); }
    }),
    disconnect: async () => { await bridge.disconnect(); },
  });
}

export interface WalletAdapterTripwires {
  readonly permission: number;
  readonly read: number;
  readonly disconnect: number;
  readonly sign: number;
  readonly send: number;
  readonly inject: number;
  readonly broadcast: number;
  readonly contract: number;
  readonly fee: number;
  readonly observe: number;
}

export function createDeterministicWalletRuntime(initial: NormalizedWalletRuntime): Readonly<{
  port: WalletRuntimePort;
  tripwires: () => WalletAdapterTripwires;
  setRuntime: (runtime: NormalizedWalletRuntime) => void;
}> {
  let current = normalizeWalletRuntime(initial);
  const listeners = new Set<(change: WalletRuntimeChange) => void>();
  const counters = { permission: 0, read: 0, disconnect: 0, sign: 0, send: 0, inject: 0,
    broadcast: 0, contract: 0, fee: 0, observe: 0 };
  return Object.freeze({
    port: Object.freeze({
      requestPermission: async () => { counters.permission += 1; return Object.freeze({ status: "PERMISSIONED" as const,
        runtime: current, presentation: WALLET_REVIEW_COPY["wallet.access.connected"] }); },
      readNormalizedRuntime: async () => { counters.read += 1; return current; },
      subscribeNormalizedRuntimeChanges: (listener: (change: WalletRuntimeChange) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      disconnect: async () => { counters.disconnect += 1; },
    }),
    tripwires: () => Object.freeze({ ...counters }),
    setRuntime: (runtime) => { current = normalizeWalletRuntime(runtime); for (const listener of listeners) listener(Object.freeze({ status: "RUNTIME", runtime: current })); },
  });
}

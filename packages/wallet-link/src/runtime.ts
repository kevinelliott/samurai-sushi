const CHAIN_ID = /^Net[1-9A-HJ-NP-Za-km-z]{12}$/;
const ACCOUNT = /^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/;
const PROVIDER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const WALLET_PERMISSION_SCOPES = Object.freeze(["account"] as const);
export type WalletPermissionScope = typeof WALLET_PERMISSION_SCOPES[number];

export interface NormalizedWalletRuntime {
  readonly providerId: string;
  readonly chainId: string;
  readonly account: string;
  readonly permissionScopes: readonly WalletPermissionScope[];
}

export interface WalletRuntimePort {
  requestPermission(): Promise<NormalizedWalletRuntime>;
  readNormalizedRuntime(): Promise<NormalizedWalletRuntime>;
  subscribeNormalizedRuntimeChanges(listener: (runtime: NormalizedWalletRuntime) => void): () => void;
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
    providerId: text(row.providerId, PROVIDER, 64),
    chainId: text(row.chainId, CHAIN_ID, 15),
    account: text(row.account, ACCOUNT, 36),
    permissionScopes: ["account"] as const,
  });
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
    requestPermission: async () => normalizeWalletRuntime(await bridge.requestPermission()),
    readNormalizedRuntime: async () => normalizeWalletRuntime(await bridge.readRuntime()),
    subscribeNormalizedRuntimeChanges: (listener: (runtime: NormalizedWalletRuntime) => void) => bridge.subscribe((value) => listener(normalizeWalletRuntime(value))),
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
  const listeners = new Set<(runtime: NormalizedWalletRuntime) => void>();
  const counters = { permission: 0, read: 0, disconnect: 0, sign: 0, send: 0, inject: 0,
    broadcast: 0, contract: 0, fee: 0, observe: 0 };
  return Object.freeze({
    port: Object.freeze({
      requestPermission: async () => { counters.permission += 1; return current; },
      readNormalizedRuntime: async () => { counters.read += 1; return current; },
      subscribeNormalizedRuntimeChanges: (listener: (runtime: NormalizedWalletRuntime) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      disconnect: async () => { counters.disconnect += 1; },
    }),
    tripwires: () => Object.freeze({ ...counters }),
    setRuntime: (runtime) => { current = normalizeWalletRuntime(runtime); for (const listener of listeners) listener(current); },
  });
}

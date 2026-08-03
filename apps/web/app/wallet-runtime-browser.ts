import { createLocalnetWalletRuntimePort, type WalletRuntimePort } from "@samurai-sushi/wallet-link";

export interface SamuraiLocalnetWalletBridge {
  requestPermission(): Promise<unknown>;
  readRuntime(): Promise<unknown>;
  subscribe(listener: (value: unknown) => void): () => void;
  disconnect(): Promise<void>;
}

declare global { interface Window { samuraiLocalnetWallet?: SamuraiLocalnetWalletBridge } }

/** Loaded only after an explicit post-SETTLED account-access action. */
export function createBrowserWalletRuntimePort(): WalletRuntimePort {
  const bridge = window.samuraiLocalnetWallet;
  if (!bridge) throw new TypeError("Wallet account access is unavailable.");
  return createLocalnetWalletRuntimePort({
    requestPermission: () => bridge.requestPermission(),
    readRuntime: () => bridge.readRuntime(),
    subscribe: (listener) => bridge.subscribe(listener),
    disconnect: () => bridge.disconnect(),
  });
}

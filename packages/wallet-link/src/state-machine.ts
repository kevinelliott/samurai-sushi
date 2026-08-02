import type { NormalizedWalletRuntime } from "./runtime";

export type WalletLinkState = "UNLINKED" | "CONNECTING" | "PERMISSIONED" | "LINKED_EXISTING"
  | "CHALLENGE_ISSUED" | "PROOF_PENDING" | "LINKED" | "REJECTED" | "CANCELLED"
  | "EXPIRED" | "STALE" | "DISCONNECTED" | "REVOKED";

export interface WalletLinkSnapshot {
  readonly state: WalletLinkState;
  readonly generation: number;
  readonly sessionRevision: number;
  readonly runtime: NormalizedWalletRuntime | null;
  readonly normalizedDigest: string | null;
}

export type WalletLinkEvent =
  | { readonly kind: "CONNECT" }
  | { readonly kind: "RELOAD" }
  | { readonly kind: "DISCONNECT" }
  | { readonly kind: "RESULT"; readonly generation: number; readonly expectedSessionRevision: number;
      readonly state: Exclude<WalletLinkState, "UNLINKED" | "CONNECTING">; readonly runtime: NormalizedWalletRuntime | null;
      readonly normalizedDigest: string }
  | { readonly kind: "RUNTIME_CHANGED"; readonly generation: number; readonly expectedSessionRevision: number;
      readonly runtime: NormalizedWalletRuntime; readonly normalizedDigest: string }
  | { readonly kind: "REVOKE" };

export interface WalletLinkDecision {
  readonly disposition: "APPLY" | "DUPLICATE" | "STALE" | "CONTRADICTION";
  readonly next: WalletLinkSnapshot;
}

function safe(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function freeze(snapshot: WalletLinkSnapshot): WalletLinkSnapshot { return Object.freeze(snapshot); }

export const INITIAL_WALLET_LINK_SNAPSHOT: WalletLinkSnapshot = freeze({
  state: "UNLINKED", generation: 0, sessionRevision: 0, runtime: null, normalizedDigest: null,
});

export function reduceWalletLink(current: WalletLinkSnapshot, event: WalletLinkEvent): WalletLinkDecision {
  if (!safe(current.generation) || !safe(current.sessionRevision)) throw new TypeError("Wallet link coordinates are invalid.");
  if (event.kind === "CONNECT" || event.kind === "RELOAD") {
    if (current.generation === Number.MAX_SAFE_INTEGER) throw new TypeError("Wallet runtime generation is exhausted.");
    return Object.freeze({ disposition: "APPLY", next: freeze({ state: event.kind === "CONNECT" ? "CONNECTING" : "UNLINKED",
      generation: current.generation + 1, sessionRevision: current.sessionRevision, runtime: null, normalizedDigest: null }) });
  }
  if (event.kind === "DISCONNECT") {
    if (current.generation === Number.MAX_SAFE_INTEGER || current.sessionRevision === Number.MAX_SAFE_INTEGER) throw new TypeError("Wallet link coordinates are exhausted.");
    return Object.freeze({ disposition: "APPLY", next: freeze({ state: "DISCONNECTED", generation: current.generation + 1,
      sessionRevision: current.sessionRevision + 1, runtime: null, normalizedDigest: null }) });
  }
  if (event.kind === "REVOKE") {
    if (current.sessionRevision === Number.MAX_SAFE_INTEGER) throw new TypeError("Wallet session revision is exhausted.");
    return Object.freeze({ disposition: "APPLY", next: freeze({ ...current, state: "REVOKED",
      sessionRevision: current.sessionRevision + 1, runtime: null, normalizedDigest: null }) });
  }
  if (event.generation !== current.generation || event.expectedSessionRevision !== current.sessionRevision) {
    return Object.freeze({ disposition: "STALE", next: current });
  }
  if (event.normalizedDigest === current.normalizedDigest) return Object.freeze({ disposition: "DUPLICATE", next: current });
  if (current.normalizedDigest !== null) return Object.freeze({ disposition: "CONTRADICTION", next: current });
  if (current.sessionRevision === Number.MAX_SAFE_INTEGER) throw new TypeError("Wallet session revision is exhausted.");
  return Object.freeze({ disposition: "APPLY", next: freeze({ state: event.kind === "RUNTIME_CHANGED" ? "STALE" : event.state,
    generation: current.generation, sessionRevision: current.sessionRevision + 1, runtime: event.runtime,
    normalizedDigest: event.normalizedDigest }) });
}

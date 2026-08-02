export type WalletReviewTone = "neutral" | "progress" | "attention" | "blocking";
export interface WalletReviewCopy { readonly ref: string; readonly title: string; readonly message: string; readonly tone: WalletReviewTone }

export type WalletAccessState = "CONNECTED_UNVERIFIED" | "ACTIVE_CREDENTIAL_MATCH" | "ACCOUNT_PROOF_UNAVAILABLE" | "DISCONNECTED" | "REVOKED";
export type WalletAccessReason = "ACCOUNT_PROOF_UNAVAILABLE" | "DISCONNECTED" | "REVOKED" | null;
export interface WalletAccessView {
  readonly schemaVersion: 1;
  readonly walletLinkRef: string;
  readonly state: WalletAccessState;
  readonly runtimeGeneration: number;
  readonly sessionRevision: number;
  readonly providerId: string;
  readonly chainId: string;
  readonly account: string;
  readonly permissionScopes: readonly ["account"];
  readonly credentialMatch: boolean;
  readonly reason: WalletAccessReason;
  readonly presentation: WalletReviewCopy;
}

export interface ReceiptReviewDoorwayView {
  readonly schemaVersion: 1;
  readonly network: Readonly<{ profile: "localnet"; chainId: "NetXtJqPyJGB6Pc";
    networkLabelRef: "network.localnet-rehearsal"; label: "Localnet rehearsal" }>;
  readonly effect: string;
  readonly access: string;
  readonly actionLabel: "Connect wallet for Localnet rehearsal";
}

export const RECEIPT_REVIEW_DOORWAY = Object.freeze({
  schemaVersion: 1,
  network: Object.freeze({ profile: "localnet", chainId: "NetXtJqPyJGB6Pc",
    networkLabelRef: "network.localnet-rehearsal", label: "Localnet rehearsal" }),
  effect: "This optional review can prepare one non-transferable service receipt for the displayed account. It does not change your saved service, unlock anything, or create a financial asset.",
  access: "Connecting asks the wallet for account access on the required network. This phase does not request a signature, estimate a fee, call a contract, or send an operation.",
  actionLabel: "Connect wallet for Localnet rehearsal",
} as const satisfies ReceiptReviewDoorwayView);

export const WALLET_REVIEW_COPY = Object.freeze({
  "receipt.review.loading": Object.freeze({ ref: "receipt.review.loading", title: "Checking saved receipt review", message: "The last committed review is loading from the server. No wallet request has started.", tone: "progress" }),
  "receipt.review.restored": Object.freeze({ ref: "receipt.review.restored", title: "Receipt review restored", message: "These are the last server-acknowledged details. The wallet was not contacted automatically.", tone: "neutral" }),
  "wallet.access.required": Object.freeze({ ref: "wallet.access.required", title: "Wallet account required", message: "Connect a wallet on the displayed network to compare its reported account with an existing verified credential. No signature or operation request will be made.", tone: "neutral" }),
  "wallet.access.requesting": Object.freeze({ ref: "wallet.access.requesting", title: "Check your wallet", message: "Approve account access for the displayed network. No signature, contract call, or operation request will be made.", tone: "progress" }),
  "wallet.access.connected": Object.freeze({ ref: "wallet.access.connected", title: "Wallet connected for review", message: "The wallet reported this account and network for the current review. Account ownership has not been cryptographically verified in this phase. Nothing has been signed or sent.", tone: "neutral" }),
  "wallet.access.cancelled": Object.freeze({ ref: "wallet.access.cancelled", title: "Wallet access closed", message: "Nothing was signed or sent. Your settled service is unchanged.", tone: "neutral" }),
  "wallet.access.rejected": Object.freeze({ ref: "wallet.access.rejected", title: "Wallet access declined", message: "Nothing was signed or sent. Your settled service is unchanged.", tone: "attention" }),
  "wallet.access.disconnected": Object.freeze({ ref: "wallet.access.disconnected", title: "Wallet disconnected", message: "The receipt details remain read-only. Reconnect the same account to check readiness. Nothing was sent.", tone: "attention" }),
  "wallet.access.unavailable": Object.freeze({ ref: "wallet.access.unavailable", title: "Wallet access unavailable", message: "The wallet provider did not return a safe, recognized account state. Nothing was signed or sent.", tone: "blocking" }),
  "wallet.access.account-proof-unavailable": Object.freeze({ ref: "wallet.access.account-proof-unavailable", title: "Verified account proof unavailable", message: "The wallet reported an account, but this phase cannot request the proof needed to verify it. Nothing was signed or sent, and no receipt was prepared.", tone: "blocking" }),
  "wallet.access.wrong-network": Object.freeze({ ref: "wallet.access.wrong-network", title: "Wallet network does not match", message: "The reported wallet network does not match this review. Nothing was signed or sent.", tone: "blocking" }),
  "wallet.access.account-changed": Object.freeze({ ref: "wallet.access.account-changed", title: "Wallet account changed", message: "The current account no longer matches this receipt review. Nothing was signed or sent. Prepare updated details before continuing.", tone: "blocking" }),
  "wallet.access.permission-changed": Object.freeze({ ref: "wallet.access.permission-changed", title: "Wallet permission changed", message: "The current permission no longer satisfies this review. Nothing was signed or sent.", tone: "blocking" }),
  "receipt.review.expired": Object.freeze({ ref: "receipt.review.expired", title: "Receipt review expired", message: "The permit expired before submission. Nothing was submitted or recorded. Your settled service is unchanged.", tone: "blocking" }),
  "receipt.review.changed": Object.freeze({ ref: "receipt.review.changed", title: "Receipt details changed", message: "Nothing was sent. Review the updated account, network, payload, manifest, and expiry before continuing.", tone: "blocking" }),
  "receipt.preflight.checking": Object.freeze({ ref: "receipt.preflight.checking", title: "Checking review readiness", message: "Account, network, permission, payload, manifest, session, and expiry are being compared. Nothing will be signed or sent.", tone: "progress" }),
  "receipt.preflight.ready": Object.freeze({ ref: "receipt.preflight.ready", title: "Review ready", message: "The current wallet and receipt facts match. This phase cannot request a signature or send an operation.", tone: "neutral" }),
  "receipt.preflight.mismatch": Object.freeze({ ref: "receipt.preflight.mismatch", title: "Review needs attention", message: "The wallet or receipt facts changed. Nothing was sent. Resolve the displayed reason and review the exact details again.", tone: "blocking" }),
} satisfies Readonly<Record<string, WalletReviewCopy>>);

function invalid(): never { throw new TypeError("Wallet access view is unavailable."); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.getOwnPropertyNames(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  for (const key of actual) if (!descriptors[key]?.enumerable || !("value" in descriptors[key]!)) invalid();
  return Object.fromEntries(actual.map((key) => [key, descriptors[key]!.value]));
}

export function parseWalletAccessView(value: unknown): WalletAccessView {
  const row = exact(value, ["account", "chainId", "credentialMatch", "permissionScopes", "presentation", "providerId", "reason",
    "runtimeGeneration", "schemaVersion", "sessionRevision", "state", "walletLinkRef"]);
  const states: readonly WalletAccessState[] = ["CONNECTED_UNVERIFIED", "ACTIVE_CREDENTIAL_MATCH", "ACCOUNT_PROOF_UNAVAILABLE", "DISCONNECTED", "REVOKED"];
  if (row.schemaVersion !== 1 || typeof row.state !== "string" || !states.includes(row.state as WalletAccessState)
    || typeof row.walletLinkRef !== "string" || !/^wl_[A-Za-z0-9_-]{22}$/.test(row.walletLinkRef)
    || typeof row.providerId !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(row.providerId) || row.providerId.length > 64
    || typeof row.chainId !== "string" || !/^Net[1-9A-HJ-NP-Za-km-z]{12}$/.test(row.chainId)
    || typeof row.account !== "string" || !/^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/.test(row.account)
    || !Number.isSafeInteger(row.runtimeGeneration) || (row.runtimeGeneration as number) < 0
    || !Number.isSafeInteger(row.sessionRevision) || (row.sessionRevision as number) < 0
    || !Array.isArray(row.permissionScopes) || row.permissionScopes.length !== 1 || row.permissionScopes[0] !== "account"
    || typeof row.credentialMatch !== "boolean") invalid();
  const copy = exact(row.presentation, ["message", "ref", "title", "tone"]);
  const allowed = Object.values(WALLET_REVIEW_COPY).find((item) => item.ref === copy.ref && item.title === copy.title
    && item.message === copy.message && item.tone === copy.tone);
  if (!allowed) invalid();
  const expectedReason = row.state === "ACCOUNT_PROOF_UNAVAILABLE" ? "ACCOUNT_PROOF_UNAVAILABLE"
    : row.state === "DISCONNECTED" ? "DISCONNECTED" : row.state === "REVOKED" ? "REVOKED" : null;
  const expectedCopy = row.state === "ACCOUNT_PROOF_UNAVAILABLE" ? WALLET_REVIEW_COPY["wallet.access.account-proof-unavailable"]
    : row.state === "DISCONNECTED" ? WALLET_REVIEW_COPY["wallet.access.disconnected"]
      : row.state === "REVOKED" ? WALLET_REVIEW_COPY["wallet.access.unavailable"] : WALLET_REVIEW_COPY["wallet.access.connected"];
  if (row.reason !== expectedReason || row.credentialMatch !== (row.state === "ACTIVE_CREDENTIAL_MATCH") || allowed !== expectedCopy) invalid();
  return Object.freeze({ schemaVersion: 1, walletLinkRef: row.walletLinkRef, state: row.state as WalletAccessState,
    runtimeGeneration: row.runtimeGeneration as number, sessionRevision: row.sessionRevision as number,
    providerId: row.providerId, chainId: row.chainId, account: row.account, permissionScopes: Object.freeze(["account"] as const),
    credentialMatch: row.credentialMatch, reason: expectedReason, presentation: allowed });
}

export function parseReceiptReviewDoorway(value: unknown): ReceiptReviewDoorwayView {
  const row = exact(value, ["access", "actionLabel", "effect", "network", "schemaVersion"]);
  const network = exact(row.network, ["chainId", "label", "networkLabelRef", "profile"]);
  if (row.schemaVersion !== RECEIPT_REVIEW_DOORWAY.schemaVersion
    || row.effect !== RECEIPT_REVIEW_DOORWAY.effect || row.access !== RECEIPT_REVIEW_DOORWAY.access
    || row.actionLabel !== RECEIPT_REVIEW_DOORWAY.actionLabel
    || network.profile !== RECEIPT_REVIEW_DOORWAY.network.profile
    || network.chainId !== RECEIPT_REVIEW_DOORWAY.network.chainId
    || network.networkLabelRef !== RECEIPT_REVIEW_DOORWAY.network.networkLabelRef
    || network.label !== RECEIPT_REVIEW_DOORWAY.network.label) invalid();
  return RECEIPT_REVIEW_DOORWAY;
}

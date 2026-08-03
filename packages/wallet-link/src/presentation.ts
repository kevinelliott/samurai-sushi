export type WalletReviewTone = "neutral" | "progress" | "attention" | "blocking";
export type WalletReviewDisplayState =
  | "REVIEW_LOADING" | "REVIEW_RESTORED" | "ACCESS_REQUIRED" | "ACCESS_REQUESTING"
  | "ACCESS_CONNECTED" | "ACCESS_CANCELLED" | "ACCESS_REJECTED" | "ACCESS_DISCONNECTED"
  | "ACCESS_UNAVAILABLE" | "ACCOUNT_PROOF_UNAVAILABLE" | "WRONG_NETWORK" | "ACCOUNT_CHANGED"
  | "PERMISSION_CHANGED" | "PROVIDER_CHANGED" | "REVIEW_EXPIRED" | "REVIEW_CHANGED"
  | "PREFLIGHT_CHECKING" | "PREFLIGHT_READY" | "PREFLIGHT_NOT_READY";
export type WalletReviewRecoveryRef =
  | "review.close"
  | "wallet.access.close" | "wallet.access.connect" | "wallet.access.retry" | "wallet.access.reconnect" | "wallet.access.retry-network"
  | "receipt.preflight.retry" | "receipt.review.restore" | "receipt.review.refresh";
export type WalletReviewRecoveryAction = Readonly<{ readonly ref: WalletReviewRecoveryRef; readonly label: string }> | null;
export interface WalletReviewCopy {
  readonly ref: string;
  readonly title: string;
  readonly message: string;
  readonly tone: WalletReviewTone;
  readonly displayState: WalletReviewDisplayState;
  readonly reasonRef: string | null;
  readonly recoveryAction: WalletReviewRecoveryAction;
}

export type WalletAccessState = "CONNECTED_UNVERIFIED" | "ACTIVE_CREDENTIAL_MATCH" | "ACCOUNT_PROOF_UNAVAILABLE" | "DISCONNECTED" | "REVOKED";
export type WalletAccessReason = "ACCOUNT_PROOF_UNAVAILABLE" | "DISCONNECTED" | "REVOKED" | null;
export interface WalletAccessView {
  readonly schemaVersion: 1;
  readonly walletLinkRef: string;
  readonly state: WalletAccessState;
  readonly runtimeGeneration: number;
  readonly sessionRevision: number;
  readonly providerId: "localnet-wallet" | "deterministic-wallet";
  readonly chainId: string;
  readonly account: string;
  readonly permissionScopes: readonly ["account"];
  readonly credentialMatch: boolean;
  readonly reason: WalletAccessReason;
  readonly presentation: WalletReviewCopy;
}

export interface DisplayOnlyWalletAccessView {
  readonly schemaVersion: 1;
  readonly accessScope: "DISPLAY_ONLY";
  readonly state: "ACCOUNT_PROOF_UNAVAILABLE";
  readonly providerId: "localnet-wallet" | "deterministic-wallet";
  readonly chainId: string;
  readonly account: string;
  readonly permissionScopes: readonly ["account"];
  readonly credentialMatch: false;
  readonly reason: "ACCOUNT_PROOF_UNAVAILABLE";
  readonly presentation: WalletReviewCopy;
}

export type WalletRuntimeSyncView = WalletAccessView | DisplayOnlyWalletAccessView;

export interface ReceiptReviewDoorwayView {
  readonly schemaVersion: 1;
  readonly network: Readonly<{ profile: "localnet"; chainId: "NetXtJqPyJGB6Pc";
    networkLabelRef: "network.localnet-rehearsal"; label: "Localnet rehearsal";
    manifestVerificationRef: "manifest.registered-verified"; manifestVerification: "Registered manifest verified" }>;
  readonly effect: string;
  readonly access: string;
  readonly actionLabel: "Connect wallet for Localnet rehearsal";
}

export const RECEIPT_REVIEW_DOORWAY = Object.freeze({
  schemaVersion: 1,
  network: Object.freeze({ profile: "localnet", chainId: "NetXtJqPyJGB6Pc",
    networkLabelRef: "network.localnet-rehearsal", label: "Localnet rehearsal",
    manifestVerificationRef: "manifest.registered-verified", manifestVerification: "Registered manifest verified" }),
  effect: "This optional review can prepare one non-transferable service receipt for the displayed account. It does not change your saved service, unlock anything, or create a financial asset.",
  access: "Connecting asks the wallet for account access on the required network. This phase does not request a signature, estimate a fee, call a contract, or send an operation.",
  actionLabel: "Connect wallet for Localnet rehearsal",
} as const satisfies ReceiptReviewDoorwayView);

function row(ref: string, title: string, message: string, tone: WalletReviewTone,
  displayState: WalletReviewDisplayState, reasonRef: string | null,
  recoveryAction: WalletReviewRecoveryAction): WalletReviewCopy {
  return Object.freeze({ ref, title, message, tone, displayState, reasonRef,
    recoveryAction: recoveryAction ? Object.freeze(recoveryAction) : null });
}

export const WALLET_REVIEW_COPY = Object.freeze({
  "receipt.review.loading": row("receipt.review.loading", "Checking saved receipt review", "The last committed review is loading from the server. No wallet request has started.", "progress", "REVIEW_LOADING", null, { ref: "review.close", label: "Not now" }),
  "receipt.review.restored": row("receipt.review.restored", "Receipt review restored", "These are the last server-acknowledged details. The wallet was not contacted automatically.", "neutral", "REVIEW_RESTORED", null, null),
  "wallet.access.required": row("wallet.access.required", "Wallet account required", "Connect a wallet on the displayed network to compare its reported account with an existing verified credential. No signature or operation request will be made.", "neutral", "ACCESS_REQUIRED", null, { ref: "wallet.access.connect", label: "Connect wallet for Localnet rehearsal" }),
  "wallet.access.requesting": row("wallet.access.requesting", "Check your wallet", "Approve account access for the displayed network. No signature, contract call, or operation request will be made.", "progress", "ACCESS_REQUESTING", null, { ref: "wallet.access.close", label: "Not now" }),
  "wallet.access.connected": row("wallet.access.connected", "Wallet connected for review", "The wallet reported this account and network for the current review. Account ownership has not been cryptographically verified in this phase. Nothing has been signed or sent.", "neutral", "ACCESS_CONNECTED", null, null),
  "wallet.access.cancelled": row("wallet.access.cancelled", "Wallet access cancelled", "The wallet reported that account access was cancelled. Nothing was signed or sent. Your settled service is unchanged.", "neutral", "ACCESS_CANCELLED", "wallet.access.cancelled", { ref: "wallet.access.retry", label: "Try connecting again" }),
  "wallet.access.rejected": row("wallet.access.rejected", "Wallet access declined", "Nothing was signed or sent. Your settled service is unchanged.", "attention", "ACCESS_REJECTED", "wallet.access.rejected", { ref: "wallet.access.retry", label: "Try connecting again" }),
  "wallet.access.disconnected": row("wallet.access.disconnected", "Wallet disconnected", "The receipt details remain read-only. Reconnect the same account to check readiness. Nothing was sent.", "attention", "ACCESS_DISCONNECTED", "wallet.access.disconnected", { ref: "wallet.access.reconnect", label: "Reconnect matching wallet" }),
  "wallet.access.unavailable": row("wallet.access.unavailable", "Wallet access unavailable", "The wallet provider did not return a safe, recognized account state. Nothing was signed or sent.", "blocking", "ACCESS_UNAVAILABLE", "wallet.access.unavailable", { ref: "wallet.access.retry", label: "Try connecting again" }),
  "wallet.access.account-proof-unavailable": row("wallet.access.account-proof-unavailable", "Verified account proof unavailable", "The wallet reported an account, but this phase cannot request the proof needed to verify it. Nothing was signed or sent, and no receipt was prepared.", "blocking", "ACCOUNT_PROOF_UNAVAILABLE", "wallet.access.account-proof-unavailable", null),
  "wallet.access.wrong-network": row("wallet.access.wrong-network", "Wallet network does not match", "The wallet reported a different network. This review requires Localnet rehearsal (NetXtJqPyJGB6Pc). Nothing was signed or sent.", "blocking", "WRONG_NETWORK", "wallet.access.wrong-network", { ref: "wallet.access.retry-network", label: "Try again on Localnet rehearsal" }),
  "wallet.access.account-changed": row("wallet.access.account-changed", "Wallet account changed", "The current account no longer matches this receipt review. Nothing was signed or sent. Reconnect the matching account before continuing.", "blocking", "ACCOUNT_CHANGED", "wallet.access.account-changed", { ref: "wallet.access.reconnect", label: "Reconnect matching wallet" }),
  "wallet.access.permission-changed": row("wallet.access.permission-changed", "Wallet permission changed", "The current permission no longer satisfies this review. Nothing was signed or sent.", "blocking", "PERMISSION_CHANGED", "wallet.access.permission-changed", { ref: "wallet.access.reconnect", label: "Reconnect wallet" }),
  "wallet.access.provider-changed": row("wallet.access.provider-changed", "Wallet provider changed", "The current provider no longer matches this receipt review. Nothing was signed or sent.", "blocking", "PROVIDER_CHANGED", "wallet.access.provider-changed", { ref: "wallet.access.reconnect", label: "Reconnect matching wallet" }),
  "receipt.review.expired": row("receipt.review.expired", "Receipt review expired", "The permit expired before submission. Nothing was submitted or recorded. Your settled service is unchanged.", "blocking", "REVIEW_EXPIRED", "receipt.review.expired", { ref: "receipt.review.refresh", label: "Prepare a fresh review" }),
  "receipt.review.changed": row("receipt.review.changed", "Receipt details changed", "Nothing was sent. Review the updated account, network, payload, manifest, and expiry before continuing.", "blocking", "REVIEW_CHANGED", "receipt.review.changed", { ref: "receipt.review.restore", label: "Review updated details" }),
  "receipt.preflight.checking": row("receipt.preflight.checking", "Checking review readiness", "Account, network, permission, payload, manifest, session, and expiry are being compared. Nothing will be signed or sent.", "progress", "PREFLIGHT_CHECKING", null, { ref: "review.close", label: "Not now" }),
  "receipt.preflight.ready": row("receipt.preflight.ready", "Review ready", "The current wallet and receipt facts match. This phase cannot request a signature or send an operation.", "neutral", "PREFLIGHT_READY", null, null),
  "receipt.preflight.mismatch": row("receipt.preflight.mismatch", "Review needs attention", "The wallet or receipt facts changed. Nothing was sent. Resolve the displayed reason and review the exact details again.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.review-facts-mismatch", { ref: "receipt.preflight.retry", label: "Check again" }),
  "receipt.preflight.authentication-required": row("receipt.preflight.authentication-required", "Review sign-in changed", "The authenticated player session is no longer current. Nothing was sent. Close this review and sign in again before preparing new receipt details.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.authentication-required", { ref: "review.close", label: "Close review" }),
  "receipt.preflight.service-not-settled": row("receipt.preflight.service-not-settled", "Service is not settled", "The saved service is no longer at the exact settled checkpoint required for this review. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.service-not-settled", { ref: "review.close", label: "Close review" }),
  "receipt.preflight.not-found": row("receipt.preflight.not-found", "Receipt review unavailable", "The subject-authorized receipt review could not be restored. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.not-found", { ref: "review.close", label: "Close review" }),
  "receipt.preflight.projection-stale": row("receipt.preflight.projection-stale", "Receipt details changed", "The committed receipt projection changed. Nothing was sent. Restore and review the exact server-acknowledged details again.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.projection-stale", { ref: "receipt.review.restore", label: "Review updated details" }),
  "receipt.preflight.intent-expired": row("receipt.preflight.intent-expired", "Receipt review expired", "The permit expired before submission. Nothing was submitted or recorded. Your settled service is unchanged.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.intent-expired", { ref: "receipt.review.restore", label: "Prepare a fresh review" }),
  "receipt.preflight.wallet-link-required": row("receipt.preflight.wallet-link-required", "Matching wallet required", "No current verified wallet runtime matches this receipt review. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.wallet-link-required", { ref: "wallet.access.reconnect", label: "Reconnect matching wallet" }),
  "receipt.preflight.wallet-link-revoked": row("receipt.preflight.wallet-link-revoked", "Wallet credential revoked", "The verified wallet credential for this review is no longer active. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.wallet-link-revoked", { ref: "wallet.access.reconnect", label: "Reconnect matching wallet" }),
  "receipt.preflight.runtime-generation-stale": row("receipt.preflight.runtime-generation-stale", "Wallet connection changed", "A newer wallet connection generation replaced this review runtime. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.runtime-generation-stale", { ref: "wallet.access.reconnect", label: "Reconnect matching wallet" }),
  "receipt.preflight.session-revision-stale": row("receipt.preflight.session-revision-stale", "Wallet session changed", "The wallet session revision changed after these details were reviewed. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.session-revision-stale", { ref: "wallet.access.reconnect", label: "Reconnect matching wallet" }),
  "receipt.preflight.account-changed": row("receipt.preflight.account-changed", "Wallet account changed", "The current wallet account no longer matches the receipt owner and source. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.account-changed", { ref: "wallet.access.reconnect", label: "Reconnect matching wallet" }),
  "receipt.preflight.wrong-network": row("receipt.preflight.wrong-network", "Wallet network does not match", "The current wallet network no longer matches Localnet rehearsal (NetXtJqPyJGB6Pc). Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.wrong-network", { ref: "wallet.access.retry-network", label: "Try again on Localnet rehearsal" }),
  "receipt.preflight.scope-missing": row("receipt.preflight.scope-missing", "Wallet permission changed", "The current account permission no longer satisfies this receipt review. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.scope-missing", { ref: "wallet.access.reconnect", label: "Reconnect wallet" }),
  "receipt.preflight.provider-changed": row("receipt.preflight.provider-changed", "Wallet provider changed", "The current provider no longer matches the provider acknowledged for this receipt review. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.provider-changed", { ref: "wallet.access.reconnect", label: "Reconnect matching wallet" }),
  "receipt.preflight.review-facts-mismatch": row("receipt.preflight.review-facts-mismatch", "Reviewed facts changed", "The account-bound receipt facts no longer match the exact review digest. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.review-facts-mismatch", { ref: "receipt.review.restore", label: "Review updated details" }),
  "receipt.preflight.policy-mismatch": row("receipt.preflight.policy-mismatch", "Receipt policy changed", "The registered manifest, destination, entrypoint, or zero-mutez policy no longer matches this review. Nothing was sent.", "blocking", "PREFLIGHT_NOT_READY", "receipt.preflight.policy-mismatch", { ref: "receipt.review.restore", label: "Review updated details" }),
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

export function parseWalletReviewCopy(value: unknown): WalletReviewCopy {
  const copy = exact(value, ["displayState", "message", "reasonRef", "recoveryAction", "ref", "title", "tone"]);
  const recovery = copy.recoveryAction === null ? null : exact(copy.recoveryAction, ["label", "ref"]);
  return Object.values(WALLET_REVIEW_COPY).find((item) => item.ref === copy.ref && item.title === copy.title
    && item.message === copy.message && item.tone === copy.tone && item.displayState === copy.displayState
    && item.reasonRef === copy.reasonRef
    && item.recoveryAction?.ref === recovery?.ref && item.recoveryAction?.label === recovery?.label) ?? invalid();
}

export function parseWalletAccessView(value: unknown): WalletAccessView {
  const row = exact(value, ["account", "chainId", "credentialMatch", "permissionScopes", "presentation", "providerId", "reason",
    "runtimeGeneration", "schemaVersion", "sessionRevision", "state", "walletLinkRef"]);
  const states: readonly WalletAccessState[] = ["CONNECTED_UNVERIFIED", "ACTIVE_CREDENTIAL_MATCH", "ACCOUNT_PROOF_UNAVAILABLE", "DISCONNECTED", "REVOKED"];
  if (row.schemaVersion !== 1 || typeof row.state !== "string" || !states.includes(row.state as WalletAccessState)
    || typeof row.walletLinkRef !== "string" || !/^wl_[A-Za-z0-9_-]{22}$/.test(row.walletLinkRef)
    || (row.providerId !== "localnet-wallet" && row.providerId !== "deterministic-wallet")
    || typeof row.chainId !== "string" || !/^Net[1-9A-HJ-NP-Za-km-z]{12}$/.test(row.chainId)
    || typeof row.account !== "string" || !/^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/.test(row.account)
    || !Number.isSafeInteger(row.runtimeGeneration) || (row.runtimeGeneration as number) < 0
    || !Number.isSafeInteger(row.sessionRevision) || (row.sessionRevision as number) < 0
    || !Array.isArray(row.permissionScopes) || row.permissionScopes.length !== 1 || row.permissionScopes[0] !== "account"
    || typeof row.credentialMatch !== "boolean") invalid();
  const allowed = parseWalletReviewCopy(row.presentation);
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

export function parseDisplayOnlyWalletAccessView(value: unknown): DisplayOnlyWalletAccessView {
  const row = exact(value, ["accessScope", "account", "chainId", "credentialMatch", "permissionScopes", "presentation", "providerId",
    "reason", "schemaVersion", "state"]);
  if (row.schemaVersion !== 1 || row.accessScope !== "DISPLAY_ONLY" || row.state !== "ACCOUNT_PROOF_UNAVAILABLE"
    || (row.providerId !== "localnet-wallet" && row.providerId !== "deterministic-wallet")
    || typeof row.chainId !== "string" || !/^Net[1-9A-HJ-NP-Za-km-z]{12}$/.test(row.chainId)
    || typeof row.account !== "string" || !/^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$/.test(row.account)
    || !Array.isArray(row.permissionScopes) || row.permissionScopes.length !== 1 || row.permissionScopes[0] !== "account"
    || row.credentialMatch !== false || row.reason !== "ACCOUNT_PROOF_UNAVAILABLE"
    || parseWalletReviewCopy(row.presentation) !== WALLET_REVIEW_COPY["wallet.access.account-proof-unavailable"]) invalid();
  return Object.freeze({ schemaVersion: 1, accessScope: "DISPLAY_ONLY", state: "ACCOUNT_PROOF_UNAVAILABLE",
    providerId: row.providerId, chainId: row.chainId, account: row.account,
    permissionScopes: Object.freeze(["account"] as const), credentialMatch: false,
    reason: "ACCOUNT_PROOF_UNAVAILABLE", presentation: WALLET_REVIEW_COPY["wallet.access.account-proof-unavailable"] });
}

export function parseWalletRuntimeSyncView(value: unknown): WalletRuntimeSyncView {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const scope = Object.getOwnPropertyDescriptor(value, "accessScope");
  return scope ? parseDisplayOnlyWalletAccessView(value) : parseWalletAccessView(value);
}

export function parseReceiptReviewDoorway(value: unknown): ReceiptReviewDoorwayView {
  const row = exact(value, ["access", "actionLabel", "effect", "network", "schemaVersion"]);
  const network = exact(row.network, ["chainId", "label", "manifestVerification", "manifestVerificationRef", "networkLabelRef", "profile"]);
  if (row.schemaVersion !== RECEIPT_REVIEW_DOORWAY.schemaVersion
    || row.effect !== RECEIPT_REVIEW_DOORWAY.effect || row.access !== RECEIPT_REVIEW_DOORWAY.access
    || row.actionLabel !== RECEIPT_REVIEW_DOORWAY.actionLabel
    || network.profile !== RECEIPT_REVIEW_DOORWAY.network.profile
    || network.chainId !== RECEIPT_REVIEW_DOORWAY.network.chainId
    || network.networkLabelRef !== RECEIPT_REVIEW_DOORWAY.network.networkLabelRef
    || network.label !== RECEIPT_REVIEW_DOORWAY.network.label
    || network.manifestVerificationRef !== RECEIPT_REVIEW_DOORWAY.network.manifestVerificationRef
    || network.manifestVerification !== RECEIPT_REVIEW_DOORWAY.network.manifestVerification) invalid();
  return RECEIPT_REVIEW_DOORWAY;
}

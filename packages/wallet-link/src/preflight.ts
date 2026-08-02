export const RECEIPT_PREFLIGHT_REASONS = Object.freeze([
  "AUTHENTICATION_REQUIRED", "SERVICE_NOT_SETTLED", "NOT_FOUND", "PROJECTION_STALE", "INTENT_EXPIRED",
  "WALLET_LINK_REQUIRED", "WALLET_LINK_REVOKED", "RUNTIME_GENERATION_STALE", "WALLET_SESSION_REVISION_STALE",
  "WALLET_ACCOUNT_CHANGED", "WRONG_NETWORK", "WALLET_SCOPE_MISSING", "PROVIDER_CHANGED",
  "REVIEW_FACTS_MISMATCH", "POLICY_MISMATCH",
] as const);
export type ReceiptPreflightReason = typeof RECEIPT_PREFLIGHT_REASONS[number];

export type ReceiptReviewPreflightResult = Readonly<{
  schemaVersion: 1;
  status: "REVIEW_READY";
  intentRef: string;
  projectionRevision: string;
  walletLinkRef: string;
  runtimeGeneration: number;
  sessionRevision: number;
  reviewDigest: string;
  expiresAt: string;
}> | Readonly<{ schemaVersion: 1; status: "NOT_READY"; reason: ReceiptPreflightReason }>;

export function notReady(reason: ReceiptPreflightReason): ReceiptReviewPreflightResult {
  return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason });
}

export function parseReceiptReviewPreflightResult(value: unknown): ReceiptReviewPreflightResult {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) throw new TypeError("Receipt review preflight is unavailable.");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (row.schemaVersion !== 1 || (row.status !== "REVIEW_READY" && row.status !== "NOT_READY")) throw new TypeError("Receipt review preflight is unavailable.");
  if (row.status === "NOT_READY") {
    if (keys.join(",") !== "reason,schemaVersion,status" || typeof row.reason !== "string"
      || !RECEIPT_PREFLIGHT_REASONS.includes(row.reason as ReceiptPreflightReason)) throw new TypeError("Receipt review preflight is unavailable.");
    return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason: row.reason as ReceiptPreflightReason });
  }
  if (keys.join(",") !== "expiresAt,intentRef,projectionRevision,reviewDigest,runtimeGeneration,schemaVersion,sessionRevision,status,walletLinkRef"
    || typeof row.intentRef !== "string" || !/^ri_[A-Za-z0-9_-]{22}$/.test(row.intentRef)
    || typeof row.projectionRevision !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(row.projectionRevision)
    || typeof row.reviewDigest !== "string" || !/^[0-9a-f]{64}$/.test(row.reviewDigest)
    || typeof row.walletLinkRef !== "string" || !/^wl_[A-Za-z0-9_-]{22}$/.test(row.walletLinkRef)
    || !Number.isSafeInteger(row.runtimeGeneration) || (row.runtimeGeneration as number) < 0
    || !Number.isSafeInteger(row.sessionRevision) || (row.sessionRevision as number) < 0
    || typeof row.expiresAt !== "string" || !Number.isFinite(Date.parse(row.expiresAt))
    || new Date(row.expiresAt).toISOString() !== row.expiresAt) throw new TypeError("Receipt review preflight is unavailable.");
  return Object.freeze(row) as ReceiptReviewPreflightResult;
}

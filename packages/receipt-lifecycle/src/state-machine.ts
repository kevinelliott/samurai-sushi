export const RECEIPT_INTENT_STATES = Object.freeze([
  "DRAFT",
  "REVIEWED",
  "AWAITING_SIGNATURE",
  "SUBMITTED",
  "INCLUDED",
  "CONFIRMED",
  "FINALIZED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "REORGED",
] as const);

export type ReceiptIntentState = (typeof RECEIPT_INTENT_STATES)[number];

export const OPERATION_ATTEMPT_STATES = Object.freeze([
  "SUBMITTED",
  "INCLUDED",
  "CONFIRMED",
  "FINALIZED",
  "FAILED",
  "DROPPED",
  "REPLACED",
  "REORGED",
] as const);

export type OperationAttemptState = (typeof OPERATION_ATTEMPT_STATES)[number];

const INTENT_TRANSITIONS: Readonly<Record<ReceiptIntentState, readonly ReceiptIntentState[]>> = Object.freeze({
  DRAFT: ["REVIEWED", "EXPIRED"],
  REVIEWED: ["AWAITING_SIGNATURE", "EXPIRED"],
  AWAITING_SIGNATURE: ["SUBMITTED", "CANCELLED", "REJECTED", "EXPIRED"],
  SUBMITTED: ["INCLUDED"],
  INCLUDED: ["CONFIRMED", "REORGED"],
  CONFIRMED: ["FINALIZED", "REORGED"],
  FINALIZED: [],
  CANCELLED: [],
  REJECTED: [],
  EXPIRED: [],
  REORGED: ["INCLUDED"],
});

const ATTEMPT_TRANSITIONS: Readonly<Record<OperationAttemptState, readonly OperationAttemptState[]>> = Object.freeze({
  SUBMITTED: ["INCLUDED", "FAILED", "DROPPED", "REPLACED"],
  INCLUDED: ["CONFIRMED", "FAILED", "REORGED"],
  CONFIRMED: ["FINALIZED", "REORGED"],
  FINALIZED: [],
  FAILED: [],
  DROPPED: [],
  REPLACED: [],
  REORGED: ["INCLUDED", "DROPPED"],
});

export class ReceiptLifecycleTransitionError extends Error {
  constructor(readonly code: "ILLEGAL_INTENT_TRANSITION" | "ILLEGAL_ATTEMPT_TRANSITION", message: string) {
    super(message);
    this.name = "ReceiptLifecycleTransitionError";
  }
}

export function assertIntentTransition(from: ReceiptIntentState, to: ReceiptIntentState): void {
  if (!INTENT_TRANSITIONS[from].includes(to)) {
    throw new ReceiptLifecycleTransitionError("ILLEGAL_INTENT_TRANSITION", `Receipt intent cannot transition from ${from} to ${to}.`);
  }
}

export function assertAttemptTransition(from: OperationAttemptState, to: OperationAttemptState): void {
  if (!ATTEMPT_TRANSITIONS[from].includes(to)) {
    throw new ReceiptLifecycleTransitionError("ILLEGAL_ATTEMPT_TRANSITION", `Operation attempt cannot transition from ${from} to ${to}.`);
  }
}

export function assertExpiryTransition(from: ReceiptIntentState, databaseNow: string, expiresAt: string): void {
  if (!["DRAFT", "REVIEWED", "AWAITING_SIGNATURE"].includes(from)) {
    throw new ReceiptLifecycleTransitionError("ILLEGAL_INTENT_TRANSITION", `Receipt intent cannot expire from ${from}.`);
  }
  const now = Date.parse(databaseNow);
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiry) || now < expiry) {
    throw new ReceiptLifecycleTransitionError("ILLEGAL_INTENT_TRANSITION", "Receipt intent cannot expire before its exact database-clock boundary.");
  }
}

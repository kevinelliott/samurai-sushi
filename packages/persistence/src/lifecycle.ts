const SECOND_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

export interface PersistenceLifecyclePolicy {
  readonly sessionLifetimeMs: number;
  readonly predecessorGraceMs: number;
  readonly receiptLifetimeMs: number;
  readonly tombstoneLifetimeMs: number;
  readonly cleanupMaximumDelayMs: number;
}

export const ADR_0003_PERSISTENCE_LIFECYCLE: PersistenceLifecyclePolicy = Object.freeze({
  sessionLifetimeMs: 30 * DAY_MS,
  predecessorGraceMs: 60 * SECOND_MS,
  receiptLifetimeMs: 30 * DAY_MS,
  tombstoneLifetimeMs: 30 * DAY_MS,
  cleanupMaximumDelayMs: DAY_MS,
});

export function assertPersistenceLifecycle(policy: PersistenceLifecyclePolicy): void {
  if (policy.predecessorGraceMs !== 60 * SECOND_MS) {
    throw new Error("ADR 0003 requires an exact 60-second predecessor-cookie grace window.");
  }
  if (policy.receiptLifetimeMs !== policy.sessionLifetimeMs) {
    throw new Error("Command receipts and guest sessions must share the exact 30-day authority horizon.");
  }
  if (policy.tombstoneLifetimeMs < policy.receiptLifetimeMs) {
    throw new Error("Replay tombstones must not expire before the receipt horizon they replace.");
  }
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe millisecond duration.`);
  }
}

assertPersistenceLifecycle(ADR_0003_PERSISTENCE_LIFECYCLE);

export function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

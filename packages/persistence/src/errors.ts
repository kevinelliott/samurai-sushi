export class PersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}

export class GuestResumeError extends PersistenceError {
  constructor(code: "GUEST_RESUME_INVALID" | "GUEST_RESUME_EXPIRED") {
    super(code, code === "GUEST_RESUME_EXPIRED" ? "The guest session has expired." : "The guest resume secret is invalid.");
    this.name = "GuestResumeError";
  }
}

export class GuestRotationDeferredError extends PersistenceError {
  constructor(readonly retryAtMs: number) {
    super("GUEST_ROTATION_DEFERRED", "A predecessor credential is still inside its bounded grace window.");
    this.name = "GuestRotationDeferredError";
  }
}

export class GuestRotationRequiredError extends PersistenceError {
  constructor() {
    super("GUEST_ROTATION_REQUIRED", "The guest credential must be rotated before commands are admitted.");
    this.name = "GuestRotationRequiredError";
  }
}

export class CommandAuthenticationError extends PersistenceError {
  constructor() {
    super("COMMAND_AUTHENTICATION_FAILED", "The guest command credential is invalid or expired.");
    this.name = "CommandAuthenticationError";
  }
}

export class IdempotencyReceiptExpiredError extends PersistenceError {
  constructor() {
    super("IDEMPOTENCY_RECEIPT_EXPIRED", "The repeatable response horizon for this idempotency key has expired.");
    this.name = "IdempotencyReceiptExpiredError";
  }
}

export class IdempotencyPayloadMismatchError extends PersistenceError {
  constructor() {
    super("IDEMPOTENCY_PAYLOAD_MISMATCH", "The idempotency key was already used for a different canonical command.");
    this.name = "IdempotencyPayloadMismatchError";
  }
}

export class RevisionConflictError extends PersistenceError {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super("REVISION_CONFLICT", `Expected revision ${expectedRevision}, but the durable revision is ${actualRevision}.`);
    this.name = "RevisionConflictError";
  }
}

export class MigrationChangedError extends PersistenceError {
  constructor(readonly migrationName: string) {
    super("MIGRATION_CHANGED", `Applied migration ${migrationName} no longer matches its recorded checksum.`);
    this.name = "MigrationChangedError";
  }
}

export class MigrationSchemaDriftError extends PersistenceError {
  constructor(message = "The live persistence schema does not match its migration ledger attestation.") {
    super("MIGRATION_SCHEMA_DRIFT", message);
    this.name = "MigrationSchemaDriftError";
  }
}

export class OutboxClaimLostError extends PersistenceError {
  constructor() {
    super("OUTBOX_CLAIM_LOST", "The outbox delivery is no longer owned by this worker claim.");
    this.name = "OutboxClaimLostError";
  }
}

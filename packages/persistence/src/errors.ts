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

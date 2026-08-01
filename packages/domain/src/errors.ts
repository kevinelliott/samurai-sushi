import type { PersistenceFailure, PersistenceFailureCode } from "./model";

const RETRYABLE_FAILURES: ReadonlySet<PersistenceFailureCode> = new Set([
  "REVISION_CONFLICT",
  "DISCONNECTED",
]);

export class PersistenceDomainError extends Error {
  readonly failure: PersistenceFailure;

  constructor(
    readonly code: PersistenceFailureCode,
    message: string,
    details: Pick<PersistenceFailure, "expectedRevision" | "actualRevision"> = {},
  ) {
    super(message);
    this.name = "PersistenceDomainError";
    const failure: PersistenceFailure = {
      code,
      message,
      retryable: RETRYABLE_FAILURES.has(code),
    };
    this.failure = details.expectedRevision === undefined && details.actualRevision === undefined
      ? failure
      : {
          ...failure,
          ...(details.expectedRevision === undefined ? {} : { expectedRevision: details.expectedRevision }),
          ...(details.actualRevision === undefined ? {} : { actualRevision: details.actualRevision }),
        };
  }
}

export function revisionConflict(expectedRevision: number, actualRevision: number): PersistenceFailure {
  return {
    code: "REVISION_CONFLICT",
    message: `Expected revision ${expectedRevision}, but durable state is at revision ${actualRevision}.`,
    retryable: true,
    expectedRevision,
    actualRevision,
  };
}

export function disconnectedFailure(): PersistenceFailure {
  return {
    code: "DISCONNECTED",
    message: "The server did not acknowledge the command; remain at the last durable checkpoint.",
    retryable: true,
  };
}

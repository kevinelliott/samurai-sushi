export interface RuntimePin {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly revision: string;
  readonly profileEntrypoint: string;
}

export interface RuntimeState {
  readonly revision: string;
  readonly porcelain: string;
}

export class RuntimePinError extends Error {
  readonly code = "RUNTIME_REVISION_UNAPPROVED";

  constructor(message: string) {
    super(message);
    this.name = "RuntimePinError";
  }
}

export function validateRuntimePin(value: unknown): RuntimePin {
  if (!value || typeof value !== "object") throw new RuntimePinError("Runtime pin must be an object.");
  const pin = value as Partial<RuntimePin>;
  if (
    pin.schemaVersion !== 1 ||
    typeof pin.repository !== "string" ||
    !/^\.\.\/[a-z0-9-]+$/.test(pin.repository) ||
    typeof pin.revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(pin.revision) ||
    pin.profileEntrypoint !== "scripts/profile.mjs"
  ) {
    throw new RuntimePinError("Runtime pin is malformed or escapes the sibling repository boundary.");
  }
  return pin as RuntimePin;
}

export function assertApprovedRuntimeState(pin: RuntimePin, state: RuntimeState): void {
  if (state.revision !== pin.revision) {
    throw new RuntimePinError(
      `Shared Tezos runtime must be exact revision ${pin.revision}; received ${state.revision}.`,
    );
  }
  if (state.porcelain.trim()) {
    throw new RuntimePinError("Shared Tezos runtime worktree must be clean before a project command runs.");
  }
}

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface GuestSubjectRef {
  readonly kind: "guest";
  readonly guestSessionId: string;
}

export interface PlayerSubjectRef {
  readonly kind: "player";
  readonly playerId: string;
}

export type SubjectRef = GuestSubjectRef | PlayerSubjectRef;

declare const idempotencyKeyBrand: unique symbol;
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: true };

declare const commandPayloadHashBrand: unique symbol;
export type CommandPayloadHash = `sha256:${string}` & { readonly [commandPayloadHashBrand]: true };

export interface CommandEnvelope<TPayload extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly commandName: string;
  readonly subject: SubjectRef;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedRevision: number;
  readonly contentVersion: string;
  readonly payload: TPayload;
  readonly payloadHash: CommandPayloadHash;
}

export interface StoredCommandResponse<TPayload extends JsonValue = JsonValue> {
  readonly schemaVersion: number;
  readonly payload: TPayload;
}

export interface StoredCommandResult<TResponse extends JsonValue = JsonValue> {
  readonly subject: SubjectRef;
  readonly idempotencyKey: IdempotencyKey;
  readonly commandName: string;
  readonly expectedRevision: number;
  readonly contentVersion: string;
  readonly payloadHash: CommandPayloadHash;
  readonly committedRevision: number;
  readonly resultHash: `sha256:${string}`;
  readonly response: StoredCommandResponse<TResponse>;
}

export type PersistenceFailureCode =
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_PAYLOAD_MISMATCH"
  | "INVALID_COMMAND_SHAPE"
  | "DISCONNECTED";

export interface PersistenceFailure {
  readonly code: PersistenceFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;
}

export type PersistenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: PersistenceFailure };

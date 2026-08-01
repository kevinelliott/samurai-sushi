import type { CommandEnvelope, GuestSubjectRef, JsonObject, JsonValue } from "@samurai-sushi/domain";

/**
 * Narrow persistence view of the domain command envelope. Keeping this adapter
 * isolated makes the package boundary explicit while @samurai-sushi/domain is
 * developed in parallel.
 */
export type PersistenceCommandEnvelope<Payload extends JsonValue> = CommandEnvelope<Payload> & {
  readonly subject: GuestSubjectRef;
};

export interface PersistenceEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly payload: JsonObject;
}

export interface PersistenceResponse<ResponsePayload extends JsonValue> {
  readonly schemaVersion: number;
  readonly payload: ResponsePayload;
}

export interface PersistenceDecision<Checkpoint extends JsonObject, ResponsePayload extends JsonValue> {
  readonly checkpointSchemaVersion: number;
  readonly checkpoint: Checkpoint;
  readonly event: PersistenceEvent;
  readonly response: PersistenceResponse<ResponsePayload>;
}

export type PersistenceCommandHandler<Payload extends JsonValue, Checkpoint extends JsonObject, ResponsePayload extends JsonValue> = (
  checkpoint: Readonly<Checkpoint>,
  command: Readonly<PersistenceCommandEnvelope<Payload>>,
) => PersistenceDecision<Checkpoint, ResponsePayload> | Promise<PersistenceDecision<Checkpoint, ResponsePayload>>;

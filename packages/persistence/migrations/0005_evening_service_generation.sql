ALTER TABLE samurai_persistence.guest_progress
  ADD CONSTRAINT guest_progress_service_generation_check CHECK (
    content_version <> 'phase-1-evening-service-v1'
    OR (checkpoint_schema_version = 2
      AND jsonb_typeof(checkpoint -> 'generation') = 'number'
      AND checkpoint ->> 'generation' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (checkpoint ->> 'generation')::numeric <= 9007199254740991)
  ) NOT VALID;

ALTER TABLE samurai_persistence.player_progress
  ADD CONSTRAINT player_progress_service_generation_check CHECK (
    content_version <> 'phase-1-evening-service-v1'
    OR (checkpoint_schema_version = 2
      AND jsonb_typeof(checkpoint -> 'generation') = 'number'
      AND checkpoint ->> 'generation' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (checkpoint ->> 'generation')::numeric <= 9007199254740991)
  ) NOT VALID;

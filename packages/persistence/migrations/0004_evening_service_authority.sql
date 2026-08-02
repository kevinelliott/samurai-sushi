ALTER TABLE samurai_persistence.guest_progress
  ADD CONSTRAINT guest_progress_safe_revision_check
  CHECK (revision <= 9007199254740991);

ALTER TABLE samurai_persistence.command_receipts
  DROP CONSTRAINT command_receipts_check,
  ADD COLUMN checkpoint_advanced boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT command_receipts_safe_revision_check CHECK (
    expected_revision BETWEEN 0 AND 9007199254740991
    AND committed_revision BETWEEN 0 AND 9007199254740991
  ),
  ADD CONSTRAINT command_receipts_revision_transition_check CHECK (
    (checkpoint_advanced AND committed_revision = expected_revision + 1)
    OR (NOT checkpoint_advanced AND committed_revision = expected_revision)
  );

ALTER TABLE samurai_persistence.domain_events
  ADD CONSTRAINT domain_events_safe_revision_check
  CHECK (committed_revision BETWEEN 1 AND 9007199254740991);

ALTER TABLE samurai_persistence.outbox_deliveries
  ADD CONSTRAINT outbox_deliveries_safe_generation_check
  CHECK (claim_generation BETWEEN 0 AND 9007199254740991);

ALTER TABLE samurai_persistence.progress_merges
  DROP CONSTRAINT progress_merges_check2,
  ADD CONSTRAINT progress_merges_revision_transition_check CHECK (
    (create_player AND target_player_id IS NULL AND player_revision_before IS NULL
      AND player_revision_after = guest_revision)
    OR (NOT create_player AND target_player_id = player_id AND player_revision_before IS NOT NULL
      AND player_revision_after = player_revision_before + 1)
  ) NOT VALID;

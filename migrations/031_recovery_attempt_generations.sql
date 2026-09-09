CREATE TABLE IF NOT EXISTS rednote_publish_recovery_attempt_generations (
  recovery_id UUID PRIMARY KEY
    REFERENCES rednote_publish_job_recoveries(id) ON DELETE RESTRICT,
  source_attempt_id UUID NOT NULL UNIQUE
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  recovery_attempt_id UUID NOT NULL UNIQUE
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT rednote_publish_recovery_attempt_generation_distinct_check
    CHECK (source_attempt_id <> recovery_attempt_id)
);

CREATE OR REPLACE FUNCTION guard_rednote_publish_recovery_attempt_generation()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rednote_publish_job_recoveries recovery
    JOIN rednote_publish_attempts source
      ON source.id = NEW.source_attempt_id
    JOIN rednote_publish_attempts replacement
      ON replacement.id = NEW.recovery_attempt_id
    WHERE recovery.id = NEW.recovery_id
      AND source.source_local_publish_job_id = recovery.local_publish_job_id
      AND replacement.source_local_publish_job_id =
        recovery.local_publish_job_id
      AND source.workspace_id = replacement.workspace_id
      AND source.source_notion_page_id = replacement.source_notion_page_id
      AND source.contract_revision = replacement.contract_revision
      AND source.frozen_payload = replacement.frozen_payload
      AND source.payload_digest = replacement.payload_digest
      AND source.payload_revision = replacement.payload_revision
      AND source.payload_revision = recovery.snapshot_revision
      AND source.executor_type = 'worker'
      AND replacement.executor_type = source.executor_type
      AND replacement.executor_kind = source.executor_kind
      AND replacement.executor_id = source.executor_id
      AND replacement.target_publish_at IS NOT DISTINCT FROM
        source.target_publish_at
      AND replacement.requested_at = source.requested_at
      AND replacement.approved_at = source.approved_at
      AND replacement.authorization_kind IS NOT DISTINCT FROM
        source.authorization_kind
      AND replacement.late_fallback_policy IS NOT DISTINCT FROM
        source.late_fallback_policy
      AND source.approved_at IS NOT NULL
      AND NOT source.active
      AND source.terminal_outcome = 'known_failed'
      AND source.terminal_at <= recovery.prior_completed_at
      AND source.receipt_lookup_state = 'not_required'
      AND source.dispatch_authorized_at IS NULL
      AND source.superseded_by_attempt_id = replacement.id
      AND replacement.supersedes_attempt_id = source.id
      AND replacement.superseded_by_attempt_id IS NULL
      AND replacement.active
      AND replacement.terminal_outcome IS NULL
      AND replacement.terminal_at IS NULL
      AND replacement.receipt_lookup_state = 'pending'
      AND replacement.claim_token IS NULL
      AND replacement.claim_expires_at IS NULL
      AND replacement.dispatch_authorized_at IS NULL
      AND replacement.worker_run_id IS NULL
      AND replacement.playwright_run_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM rednote_publish_attempt_events event
        WHERE event.attempt_id = source.id
          AND event.event_type IN ('execution_started', 'execution_evidence')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM rednote_publish_attempt_receipts receipt
        WHERE receipt.attempt_id = source.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM rednote_publication_evidence evidence
        WHERE evidence.workspace_id = source.workspace_id
          AND evidence.attempt_id = source.id
      )
  ) THEN
    RAISE EXCEPTION
      'recovery attempt generation does not preserve exact approved attempt state';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rednote_publish_recovery_attempt_generation_guard
  ON rednote_publish_recovery_attempt_generations;
CREATE TRIGGER rednote_publish_recovery_attempt_generation_guard
BEFORE INSERT ON rednote_publish_recovery_attempt_generations
FOR EACH ROW
EXECUTE FUNCTION guard_rednote_publish_recovery_attempt_generation();

CREATE OR REPLACE FUNCTION prevent_rednote_publish_recovery_attempt_generation_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'rednote publish recovery attempt generations are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rednote_publish_recovery_attempt_generations_append_only
  ON rednote_publish_recovery_attempt_generations;
CREATE TRIGGER rednote_publish_recovery_attempt_generations_append_only
BEFORE UPDATE OR DELETE ON rednote_publish_recovery_attempt_generations
FOR EACH ROW
EXECUTE FUNCTION prevent_rednote_publish_recovery_attempt_generation_mutation();

CREATE OR REPLACE FUNCTION rednote_recovery_attempt_generation_revision()
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$ SELECT '031'::TEXT $$;

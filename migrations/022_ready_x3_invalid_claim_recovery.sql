CREATE OR REPLACE FUNCTION guard_rednote_publish_attempt_update()
RETURNS trigger AS $$
DECLARE
  invalid_claim_recovery BOOLEAN :=
    current_setting('app.ready_x3_invalid_claim_recovery', true) = 'on'
    AND OLD.terminal_outcome = 'known_failed'
    AND NEW.terminal_outcome IS NULL
    AND OLD.receipt_lookup_state = 'not_required'
    AND NEW.receipt_lookup_state = 'pending'
    AND OLD.approved_at IS NOT NULL
    AND OLD.dispatch_authorized_at IS NULL
    AND NEW.dispatch_authorized_at IS NULL
    AND OLD.superseded_by_attempt_id IS NULL
    AND NEW.superseded_by_attempt_id IS NULL;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.contract_revision IS DISTINCT FROM OLD.contract_revision
     OR NEW.source_notion_page_id IS DISTINCT FROM OLD.source_notion_page_id
     OR NEW.source_local_publish_job_id IS DISTINCT FROM OLD.source_local_publish_job_id
     OR NEW.frozen_payload IS DISTINCT FROM OLD.frozen_payload
     OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
     OR NEW.payload_revision IS DISTINCT FROM OLD.payload_revision
     OR NEW.executor_type IS DISTINCT FROM OLD.executor_type
     OR NEW.executor_kind IS DISTINCT FROM OLD.executor_kind
     OR NEW.executor_id IS DISTINCT FROM OLD.executor_id
     OR NEW.target_publish_at IS DISTINCT FROM OLD.target_publish_at
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.supersedes_attempt_id IS DISTINCT FROM OLD.supersedes_attempt_id
     OR NEW.diagnostics IS DISTINCT FROM OLD.diagnostics THEN
    RAISE EXCEPTION 'rednote publish attempt immutable fields cannot be changed';
  END IF;

  IF (OLD.worker_run_id IS NOT NULL
      AND NEW.worker_run_id IS DISTINCT FROM OLD.worker_run_id)
     OR (OLD.playwright_run_id IS NOT NULL
         AND NEW.playwright_run_id IS DISTINCT FROM OLD.playwright_run_id) THEN
    RAISE EXCEPTION 'rednote publish attempt run identities are immutable once bound';
  END IF;

  IF OLD.terminal_outcome IS NOT NULL
     AND (
       NEW.terminal_outcome IS DISTINCT FROM OLD.terminal_outcome
       OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at
     )
     AND NOT invalid_claim_recovery THEN
    RAISE EXCEPTION 'rednote publish attempt terminal outcome is immutable once set';
  END IF;

  IF NEW.receipt_lookup_state IS DISTINCT FROM OLD.receipt_lookup_state
     AND NOT (
        (OLD.receipt_lookup_state = 'pending'
         AND NEW.receipt_lookup_state IN (
           'identity_pending', 'not_found', 'found', 'not_required'
         ))
        OR (OLD.receipt_lookup_state = 'identity_pending'
            AND NEW.receipt_lookup_state IN ('not_found', 'found', 'not_required'))
        OR (OLD.receipt_lookup_state = 'not_found'
            AND NEW.receipt_lookup_state IN ('found', 'not_required'))
        OR invalid_claim_recovery
     ) THEN
    RAISE EXCEPTION 'invalid rednote publish attempt receipt lookup transition';
  END IF;

  IF NEW.receipt_lookup_updated_at < OLD.receipt_lookup_updated_at THEN
    RAISE EXCEPTION 'rednote publish attempt receipt lookup time cannot move backwards';
  END IF;

  IF OLD.approved_at IS NOT NULL
     AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'rednote publish attempt approval is immutable once recorded';
  END IF;

  IF NOT OLD.active
     AND NEW.active
     AND NOT (
       (
         OLD.approved_at IS NULL
         AND NEW.approved_at IS NOT NULL
         AND OLD.executor_type = 'worker'
         AND OLD.terminal_outcome IS NULL
         AND NEW.terminal_outcome IS NULL
         AND OLD.superseded_by_attempt_id IS NULL
         AND NEW.superseded_by_attempt_id IS NULL
         AND OLD.dispatch_authorized_at IS NULL
         AND NEW.dispatch_authorized_at IS NULL
       )
       OR invalid_claim_recovery
     ) THEN
    RAISE EXCEPTION 'rednote publish attempt cannot be reactivated';
  END IF;

  IF OLD.superseded_by_attempt_id IS NOT NULL
     AND NEW.superseded_by_attempt_id IS DISTINCT FROM OLD.superseded_by_attempt_id THEN
    RAISE EXCEPTION 'rednote publish attempt supersession is immutable once set';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ready_x3_invalid_claim_recovery_guard_revision()
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$ SELECT '022'::TEXT $$;
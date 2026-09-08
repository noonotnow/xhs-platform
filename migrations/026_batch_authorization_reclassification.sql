CREATE OR REPLACE FUNCTION guard_ready_x3_authorization_immutable()
RETURNS trigger AS $$
DECLARE
  batch_reclassification BOOLEAN :=
    current_setting('app.batch_authorization_reclassification', true) = 'on'
    AND OLD.authorization_kind = 'ready_x3'
    AND NEW.authorization_kind IS NULL
    AND OLD.late_fallback_policy IS NOT NULL
    AND NEW.late_fallback_policy IS NULL
    AND OLD.approved_at IS NOT NULL
    AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at
    AND OLD.terminal_outcome = 'known_failed'
    AND NEW.terminal_outcome IS NULL
    AND OLD.receipt_lookup_state = 'not_required'
    AND NEW.receipt_lookup_state = 'pending'
    AND NOT OLD.active
    AND NEW.active
    AND OLD.dispatch_authorized_at IS NULL
    AND NEW.dispatch_authorized_at IS NULL
    AND OLD.superseded_by_attempt_id IS NULL
    AND NEW.superseded_by_attempt_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM local_publish_jobs job
      JOIN rednote_publish_batch_items item
        ON item.id = job.batch_item_id
       AND item.local_publish_job_id = job.id
      JOIN rednote_publish_batches batch ON batch.id = item.batch_id
      WHERE job.id = OLD.source_local_publish_job_id
        AND job.workspace_id = OLD.workspace_id
        AND job.status = 'failed'
        AND job.error_code = 'INVALID_CLAIM'
        AND job.error_message LIKE
          '%readyX3Authorization: must exactly match the frozen packet revision, schedule, and media fields%'
        AND job.staged_at IS NULL
        AND job.dispatch_authorized_at IS NULL
        AND job.dispatched_at IS NULL
        AND job.note_id IS NULL
        AND job.share_url IS NULL
        AND job.success_attestation_id IS NULL
        AND job.external_disposition_request_id IS NULL
        AND item.state = 'failed'
        AND batch.status IN ('approved', 'partially_approved')
        AND batch.approved_at IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM rednote_publish_attempt_events event
      WHERE event.attempt_id = OLD.id
        AND event.event_type = 'execution_started'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM rednote_publish_attempt_receipts receipt
      WHERE receipt.attempt_id = OLD.id
    );
BEGIN
  IF OLD.authorization_kind IS NOT NULL
     AND (
       NEW.authorization_kind IS DISTINCT FROM OLD.authorization_kind
       OR NEW.late_fallback_policy IS DISTINCT FROM OLD.late_fallback_policy
     )
     AND NOT batch_reclassification THEN
    RAISE EXCEPTION 'Ready x3 authorization is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION batch_authorization_reclassification_guard_revision()
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$ SELECT '026'::TEXT $$;

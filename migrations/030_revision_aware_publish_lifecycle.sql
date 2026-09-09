CREATE OR REPLACE FUNCTION rednote_publish_revision_is_valid(
  revision TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF revision IS NULL
    OR revision !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
  THEN
    RETURN false;
  END IF;
  PERFORM revision::timestamptz;
  RETURN true;
EXCEPTION
  WHEN invalid_datetime_format
    OR datetime_field_overflow
    OR invalid_time_zone_displacement_value
  THEN RETURN false;
END;
$$;

ALTER TABLE rednote_publish_batches
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

UPDATE rednote_publish_batches
SET workspace_id = 'legacy-local-publish'
WHERE workspace_id IS NULL;

ALTER TABLE rednote_publish_batches
  ALTER COLUMN workspace_id SET DEFAULT 'legacy-local-publish',
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE rednote_publish_batches
  DROP CONSTRAINT IF EXISTS rednote_publish_batches_workspace_check;

ALTER TABLE rednote_publish_batches
  ADD CONSTRAINT rednote_publish_batches_workspace_check
  CHECK (char_length(workspace_id) BETWEEN 1 AND 128);

ALTER TABLE rednote_publish_batch_items
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

UPDATE rednote_publish_batch_items AS item
SET workspace_id = batch.workspace_id
FROM rednote_publish_batches AS batch
WHERE batch.id = item.batch_id
  AND item.workspace_id IS NULL;

ALTER TABLE rednote_publish_batch_items
  ALTER COLUMN workspace_id SET DEFAULT 'legacy-local-publish',
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE rednote_publish_batch_items
  DROP CONSTRAINT IF EXISTS rednote_publish_batch_items_workspace_check;

ALTER TABLE rednote_publish_batch_items
  ADD CONSTRAINT rednote_publish_batch_items_workspace_check
  CHECK (char_length(workspace_id) BETWEEN 1 AND 128);

ALTER TABLE rednote_publish_attempt_events
  DROP CONSTRAINT IF EXISTS rednote_publish_attempt_events_event_type_check;

ALTER TABLE rednote_publish_attempt_events
  ADD CONSTRAINT rednote_publish_attempt_events_event_type_check
  CHECK (event_type IN (
    'attempt_created', 'worker_claimed', 'worker_batched',
    'worker_batch_failed', 'execution_started', 'execution_evidence',
    'terminal_outcome_recorded', 'receipt_lookup', 'superseded',
    'queue_quarantined', 'administrative_recovery'
  ));

DROP INDEX IF EXISTS rednote_publish_batch_items_active_page_idx;

CREATE UNIQUE INDEX rednote_publish_batch_items_active_page_idx
  ON rednote_publish_batch_items (
    workspace_id,
    notion_page_id,
    (snapshot->>'notionLastEditedTime')
  )
  WHERE state NOT IN ('invalidated', 'reconciled', 'failed');

CREATE OR REPLACE FUNCTION rednote_publish_revision_blocks(
  frozen_revision TEXT,
  candidate_revision TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF NOT rednote_publish_revision_is_valid(frozen_revision)
    OR NOT rednote_publish_revision_is_valid(candidate_revision)
  THEN
    RETURN true;
  END IF;
  RETURN frozen_revision::timestamptz >= candidate_revision::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION rednote_publish_local_job_allows_newer_revision(
  candidate_workspace_id TEXT,
  candidate_notion_page_id TEXT,
  candidate_local_publish_job_id UUID,
  candidate_revision TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM local_publish_jobs job
    WHERE job.id = candidate_local_publish_job_id
      AND job.workspace_id = candidate_workspace_id
      AND job.notion_page_id = candidate_notion_page_id
      AND rednote_publish_revision_is_valid(candidate_revision)
      AND NOT rednote_publish_revision_blocks(
        job.snapshot->>'notionLastEditedTime',
        candidate_revision
      )
      AND job.status = 'failed'
      AND job.staged_at IS NULL
      AND job.dispatch_authorized_at IS NULL
      AND job.dispatched_at IS NULL
      AND job.verified_at IS NULL
      AND job.reconciled_at IS NULL
      AND job.note_id IS NULL
      AND job.share_url IS NULL
      AND job.success_attestation_id IS NULL
      AND job.external_disposition_request_id IS NULL
      AND job.receipt_contract_version IS NULL
      AND job.receipt_outcome IS NULL
      AND job.receipt_acknowledged_at IS NULL
      AND job.authenticated_account_id IS NULL
      AND job.authenticated_account_at IS NULL
      AND job.xsec_accessible_at IS NULL
      AND job.public_index_status IS NULL
      AND job.public_index_checked_at IS NULL
      AND job.provider_restriction_status IS NULL
      AND job.provider_restriction_reported_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM rednote_publish_attempts attempt
        WHERE attempt.workspace_id = job.workspace_id
          AND attempt.source_local_publish_job_id = job.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM rednote_publish_attempts attempt
        WHERE attempt.workspace_id = job.workspace_id
          AND attempt.source_local_publish_job_id = job.id
          AND (
            attempt.active
            OR attempt.terminal_outcome IS DISTINCT FROM 'known_failed'
            OR attempt.receipt_lookup_state IS DISTINCT FROM 'not_required'
            OR attempt.dispatch_authorized_at IS NOT NULL
            OR attempt.worker_run_id IS NOT NULL
            OR attempt.playwright_run_id IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM rednote_publish_attempt_events event
              WHERE event.attempt_id = attempt.id
                AND event.event_type IN ('execution_started', 'execution_evidence')
            )
            OR EXISTS (
              SELECT 1
              FROM rednote_publish_attempt_receipts receipt
              WHERE receipt.attempt_id = attempt.id
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM rednote_publication_evidence evidence
        WHERE evidence.workspace_id = job.workspace_id
          AND (
            evidence.local_publish_job_id = job.id
            OR evidence.attempt_id IN (
              SELECT attempt.id
              FROM rednote_publish_attempts attempt
              WHERE attempt.workspace_id = job.workspace_id
                AND attempt.source_local_publish_job_id = job.id
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM local_publish_job_success_attestations attestation
        WHERE attestation.local_publish_job_id = job.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM local_publish_job_success_attestation_release_acks acknowledgement
        JOIN local_publish_job_success_attestations attestation
          ON attestation.id = acknowledgement.success_attestation_id
        WHERE attestation.local_publish_job_id = job.id
      )
  )
$$;

CREATE OR REPLACE FUNCTION rednote_publish_revision_blockers(
  candidate_workspace_id TEXT,
  candidate_notion_page_id TEXT,
  candidate_revision TEXT,
  excluded_batch_item_id UUID,
  excluded_local_publish_job_id UUID,
  excluded_publish_attempt_id UUID
)
RETURNS TABLE (
  notion_page_id TEXT,
  lifecycle_id TEXT,
  lifecycle_state TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    candidate_notion_page_id,
    candidate_notion_page_id,
    'candidate_revision:invalid'
  WHERE NOT rednote_publish_revision_is_valid(candidate_revision)

  UNION ALL

  SELECT
    job.notion_page_id,
    job.id::text,
    'local_job:' || job.status
  FROM local_publish_jobs job
  WHERE job.workspace_id = candidate_workspace_id
    AND job.notion_page_id = candidate_notion_page_id
    AND (
      excluded_local_publish_job_id IS NULL
      OR job.id <> excluded_local_publish_job_id
    )
    AND rednote_publish_revision_is_valid(candidate_revision)
    AND NOT rednote_publish_local_job_allows_newer_revision(
      candidate_workspace_id,
      candidate_notion_page_id,
      job.id,
      candidate_revision
    )

  UNION ALL

  SELECT
    item.notion_page_id,
    item.id::text,
    'batch_item:' || item.state
  FROM rednote_publish_batch_items item
  WHERE item.workspace_id = candidate_workspace_id
    AND item.notion_page_id = candidate_notion_page_id
    AND (
      excluded_batch_item_id IS NULL
      OR item.id <> excluded_batch_item_id
    )
    AND item.state NOT IN ('invalidated', 'reconciled', 'failed')
    AND rednote_publish_revision_is_valid(candidate_revision)
    AND (
      rednote_publish_revision_blocks(
        item.snapshot->>'notionLastEditedTime',
        candidate_revision
      )
      OR item.local_publish_job_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM local_publish_jobs linked_job
        WHERE linked_job.id = item.local_publish_job_id
          AND rednote_publish_local_job_allows_newer_revision(
            candidate_workspace_id,
            candidate_notion_page_id,
            linked_job.id,
            candidate_revision
          )
      )
    )

  UNION ALL

  SELECT
    job.notion_page_id,
    job.id::text,
    'excluded_local_job:evidence'
  FROM local_publish_jobs job
  WHERE excluded_local_publish_job_id IS NOT NULL
    AND job.id = excluded_local_publish_job_id
    AND job.workspace_id = candidate_workspace_id
    AND job.notion_page_id = candidate_notion_page_id
    AND (
      job.dispatch_authorized_at IS NOT NULL
      OR job.dispatched_at IS NOT NULL
      OR job.staged_at IS NOT NULL
      OR job.note_id IS NOT NULL
      OR job.share_url IS NOT NULL
      OR job.success_attestation_id IS NOT NULL
      OR job.external_disposition_request_id IS NOT NULL
      OR job.receipt_contract_version IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM rednote_publication_evidence evidence
        WHERE evidence.workspace_id = job.workspace_id
          AND evidence.local_publish_job_id = job.id
      )
      OR EXISTS (
        SELECT 1
        FROM local_publish_job_success_attestations attestation
        WHERE attestation.local_publish_job_id = job.id
      )
      OR EXISTS (
        SELECT 1
        FROM local_publish_job_success_attestation_release_acks acknowledgement
        JOIN local_publish_job_success_attestations attestation
          ON attestation.id = acknowledgement.success_attestation_id
        WHERE attestation.local_publish_job_id = job.id
      )
      OR EXISTS (
        SELECT 1
        FROM rednote_publish_attempts linked_attempt
        WHERE linked_attempt.source_local_publish_job_id = job.id
          AND linked_attempt.workspace_id = job.workspace_id
          AND (
            excluded_publish_attempt_id IS NULL
            OR linked_attempt.id <> excluded_publish_attempt_id
          )
          AND (
            linked_attempt.active
            OR linked_attempt.terminal_outcome IS DISTINCT FROM 'known_failed'
            OR linked_attempt.receipt_lookup_state IS DISTINCT FROM 'not_required'
            OR linked_attempt.dispatch_authorized_at IS NOT NULL
            OR linked_attempt.worker_run_id IS NOT NULL
            OR linked_attempt.playwright_run_id IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM rednote_publish_attempt_events event
              WHERE event.attempt_id = linked_attempt.id
                AND event.event_type IN ('execution_started', 'execution_evidence')
            )
            OR EXISTS (
              SELECT 1
              FROM rednote_publish_attempt_receipts receipt
              WHERE receipt.attempt_id = linked_attempt.id
            )
            OR EXISTS (
              SELECT 1
              FROM rednote_publication_evidence evidence
              WHERE evidence.workspace_id = linked_attempt.workspace_id
                AND evidence.attempt_id = linked_attempt.id
            )
          )
      )
    )

  UNION ALL

  SELECT
    attempt.source_notion_page_id,
    attempt.id::text,
    'excluded_publish_attempt:evidence'
  FROM rednote_publish_attempts attempt
  WHERE excluded_publish_attempt_id IS NOT NULL
    AND attempt.id = excluded_publish_attempt_id
    AND attempt.workspace_id = candidate_workspace_id
    AND attempt.source_notion_page_id = candidate_notion_page_id
    AND (
      attempt.dispatch_authorized_at IS NOT NULL
      OR attempt.worker_run_id IS NOT NULL
      OR attempt.playwright_run_id IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM rednote_publish_attempt_events event
        WHERE event.attempt_id = attempt.id
          AND event.event_type IN ('execution_started', 'execution_evidence')
      )
      OR EXISTS (
        SELECT 1
        FROM rednote_publish_attempt_receipts receipt
        WHERE receipt.attempt_id = attempt.id
      )
      OR EXISTS (
        SELECT 1
        FROM rednote_publication_evidence evidence
        WHERE evidence.workspace_id = attempt.workspace_id
          AND evidence.attempt_id = attempt.id
      )
    )

  UNION ALL

  SELECT
    attempt.source_notion_page_id,
    attempt.id::text,
    'publish_attempt:' || COALESCE(attempt.terminal_outcome, 'active')
  FROM rednote_publish_attempts attempt
  WHERE attempt.workspace_id = candidate_workspace_id
    AND attempt.source_notion_page_id = candidate_notion_page_id
    AND (
      excluded_publish_attempt_id IS NULL
      OR attempt.id <> excluded_publish_attempt_id
    )
    AND attempt.source_local_publish_job_id IS NULL
    AND rednote_publish_revision_is_valid(candidate_revision)
    AND (
      rednote_publish_revision_blocks(attempt.payload_revision, candidate_revision)
      OR attempt.active
      OR attempt.terminal_outcome IS DISTINCT FROM 'known_failed'
      OR attempt.receipt_lookup_state IS DISTINCT FROM 'not_required'
      OR attempt.dispatch_authorized_at IS NOT NULL
      OR attempt.worker_run_id IS NOT NULL
      OR attempt.playwright_run_id IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM rednote_publish_attempt_events event
        WHERE event.attempt_id = attempt.id
          AND event.event_type IN ('execution_started', 'execution_evidence')
      )
      OR EXISTS (
        SELECT 1
        FROM rednote_publish_attempt_receipts receipt
        WHERE receipt.attempt_id = attempt.id
      )
      OR EXISTS (
        SELECT 1
        FROM rednote_publication_evidence evidence
        WHERE evidence.workspace_id = attempt.workspace_id
          AND evidence.attempt_id = attempt.id
      )
    )

  UNION ALL

  SELECT
    reconciliation.notion_page_id,
    reconciliation.id::text,
    'manual_reconciliation:' || reconciliation.status
  FROM manual_reconciliation_requests reconciliation
  WHERE reconciliation.workspace_id = candidate_workspace_id
    AND reconciliation.notion_page_id = candidate_notion_page_id

  UNION ALL

  SELECT
    reconciliation.notion_page_id,
    reconciliation.id::text,
    'external_reconciliation:' || reconciliation.status
  FROM external_post_reconciliations reconciliation
  WHERE reconciliation.workspace_id = candidate_workspace_id
    AND reconciliation.notion_page_id = candidate_notion_page_id

  UNION ALL

  SELECT
    receipt.notion_page_id,
    receipt.notion_page_id,
    'publish_receipt:' || receipt.status
  FROM xhs_publish_receipts receipt
  WHERE receipt.workspace_id = candidate_workspace_id
    AND receipt.notion_page_id = candidate_notion_page_id

  UNION ALL

  SELECT
    scheduled.notion_page_id,
    scheduled.id::text,
    'operator_scheduled'
  FROM plan_operator_scheduled_posts scheduled
  WHERE scheduled.workspace_id = candidate_workspace_id
    AND scheduled.notion_page_id = candidate_notion_page_id
$$;

CREATE OR REPLACE FUNCTION rednote_publish_revision_blockers(
  candidate_workspace_id TEXT,
  candidate_notion_page_id TEXT,
  candidate_revision TEXT,
  excluded_batch_item_id UUID
)
RETURNS TABLE (
  notion_page_id TEXT,
  lifecycle_id TEXT,
  lifecycle_state TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM rednote_publish_revision_blockers(
    candidate_workspace_id,
    candidate_notion_page_id,
    candidate_revision,
    excluded_batch_item_id,
    NULL::uuid,
    NULL::uuid
  )
$$;

CREATE OR REPLACE FUNCTION rednote_publish_revision_blockers(
  candidate_workspace_id TEXT,
  candidate_notion_page_id TEXT,
  candidate_revision TEXT
)
RETURNS TABLE (
  notion_page_id TEXT,
  lifecycle_id TEXT,
  lifecycle_state TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM rednote_publish_revision_blockers(
    candidate_workspace_id,
    candidate_notion_page_id,
    candidate_revision,
    NULL::uuid
  )
$$;

CREATE OR REPLACE FUNCTION prevent_operator_scheduled_local_dispatch()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status <> 'failed'
     AND EXISTS (
       SELECT 1
       FROM plan_operator_scheduled_posts scheduled
       WHERE scheduled.workspace_id = NEW.workspace_id
         AND scheduled.notion_page_id = NEW.notion_page_id
     ) THEN
    RAISE EXCEPTION 'manually handled post % is not dispatchable', NEW.notion_page_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guard_operator_scheduled_local_dispatch
  ON local_publish_jobs;
CREATE TRIGGER guard_operator_scheduled_local_dispatch
BEFORE INSERT OR UPDATE OF workspace_id, notion_page_id, status
ON local_publish_jobs
FOR EACH ROW EXECUTE FUNCTION prevent_operator_scheduled_local_dispatch();

CREATE OR REPLACE FUNCTION prevent_operator_scheduled_batch_dispatch()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state NOT IN ('invalidated', 'failed')
     AND EXISTS (
       SELECT 1
       FROM plan_operator_scheduled_posts scheduled
       WHERE scheduled.workspace_id = NEW.workspace_id
         AND scheduled.notion_page_id = NEW.notion_page_id
     ) THEN
    RAISE EXCEPTION 'manually handled post % cannot enter a publish batch', NEW.notion_page_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guard_operator_scheduled_batch_dispatch
  ON rednote_publish_batch_items;
CREATE TRIGGER guard_operator_scheduled_batch_dispatch
BEFORE INSERT OR UPDATE OF workspace_id, notion_page_id, state
ON rednote_publish_batch_items
FOR EACH ROW EXECUTE FUNCTION prevent_operator_scheduled_batch_dispatch();

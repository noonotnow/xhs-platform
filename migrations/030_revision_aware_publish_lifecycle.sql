CREATE OR REPLACE FUNCTION rednote_publish_revision_is_valid(
  revision TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF revision IS NULL OR btrim(revision) = '' THEN
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
    AND rednote_publish_revision_is_valid(candidate_revision)
    AND (
      rednote_publish_revision_blocks(
        job.snapshot->>'notionLastEditedTime',
        candidate_revision
      )
      OR job.status <> 'failed'
      OR job.staged_at IS NOT NULL
      OR job.dispatch_authorized_at IS NOT NULL
      OR job.dispatched_at IS NOT NULL
      OR job.verified_at IS NOT NULL
      OR job.reconciled_at IS NOT NULL
      OR job.note_id IS NOT NULL
      OR job.share_url IS NOT NULL
      OR job.success_attestation_id IS NOT NULL
      OR job.external_disposition_request_id IS NOT NULL
      OR job.receipt_contract_version IS NOT NULL
      OR job.receipt_outcome IS NOT NULL
      OR job.receipt_acknowledged_at IS NOT NULL
      OR job.authenticated_account_id IS NOT NULL
      OR job.authenticated_account_at IS NOT NULL
      OR job.xsec_accessible_at IS NOT NULL
      OR job.public_index_status IS NOT NULL
      OR job.public_index_checked_at IS NOT NULL
      OR job.provider_restriction_status IS NOT NULL
      OR job.provider_restriction_reported_at IS NOT NULL
      OR NOT EXISTS (
        SELECT 1
        FROM rednote_publish_attempts attempt
        WHERE attempt.workspace_id = job.workspace_id
          AND attempt.source_local_publish_job_id = job.id
      )
      OR EXISTS (
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
      OR EXISTS (
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
    )

  UNION ALL

  SELECT
    attempt.source_notion_page_id,
    attempt.id::text,
    'publish_attempt:' || COALESCE(attempt.terminal_outcome, 'active')
  FROM rednote_publish_attempts attempt
  WHERE attempt.workspace_id = candidate_workspace_id
    AND attempt.source_notion_page_id = candidate_notion_page_id
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

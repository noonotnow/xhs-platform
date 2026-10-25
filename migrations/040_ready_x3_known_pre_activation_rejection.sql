-- Preserve historical rejections. Only a newer revision can receive new consent.
-- A negative v2 acknowledgement is not provider acceptance, but it is only safe
-- in this explicitly bounded, unactivated Ready x3 browser-closed case.
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
        job.snapshot->>'notionLastEditedTime', candidate_revision
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
      AND (
        (
          job.receipt_contract_version IS NULL
          AND job.receipt_outcome IS NULL
          AND job.receipt_acknowledged_at IS NULL
        )
        OR (
          job.batch_item_id IS NULL
          AND job.snapshot->>'automationConsent' = 'ready_x3'
          AND job.error_code = 'BROWSER_CLOSED_PRE_PUBLISH'
          AND job.receipt_contract_version = 'rednote-worker-result/v2'
          AND job.receipt_outcome = 'rejected'
          AND job.receipt_acknowledged_at IS NOT NULL
          AND (
            SELECT COUNT(*) FROM rednote_publish_attempts bound
            WHERE bound.source_local_publish_job_id = job.id
          ) = 1
          AND EXISTS (
            SELECT 1 FROM rednote_publish_attempts bound
            WHERE bound.source_local_publish_job_id = job.id
              AND bound.workspace_id = job.workspace_id
              AND bound.source_notion_page_id = job.notion_page_id
              AND bound.payload_revision = job.snapshot->>'notionLastEditedTime'
              AND bound.authorization_kind = 'ready_x3'
              AND NOT bound.active
              AND bound.terminal_outcome = 'known_failed'
              AND bound.receipt_lookup_state = 'not_required'
          )
        )
      )
      AND job.authenticated_account_id IS NULL
      AND job.authenticated_account_at IS NULL
      AND job.xsec_accessible_at IS NULL
      AND job.public_index_status IS NULL
      AND job.public_index_checked_at IS NULL
      AND job.provider_restriction_status IS NULL
      AND job.provider_restriction_reported_at IS NULL
      AND EXISTS (
        SELECT 1 FROM rednote_publish_attempts attempt
        WHERE attempt.workspace_id = job.workspace_id
          AND attempt.source_local_publish_job_id = job.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM rednote_publish_attempts attempt
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
              SELECT 1 FROM rednote_publish_attempt_events event
              WHERE event.attempt_id = attempt.id
                AND event.event_type IN ('execution_started', 'execution_evidence')
            )
            OR EXISTS (
              SELECT 1 FROM rednote_publish_attempt_receipts receipt
              WHERE receipt.attempt_id = attempt.id
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM rednote_publication_evidence evidence
        WHERE evidence.workspace_id = job.workspace_id
          AND (
            evidence.local_publish_job_id = job.id
            OR evidence.attempt_id IN (
              SELECT attempt.id FROM rednote_publish_attempts attempt
              WHERE attempt.workspace_id = job.workspace_id
                AND attempt.source_local_publish_job_id = job.id
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM local_publish_job_success_attestations attestation
        WHERE attestation.local_publish_job_id = job.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM local_publish_job_success_attestation_release_acks acknowledgement
        JOIN local_publish_job_success_attestations attestation
          ON attestation.id = acknowledgement.success_attestation_id
        WHERE attestation.local_publish_job_id = job.id
      )
  )
$$;

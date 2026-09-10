CREATE OR REPLACE FUNCTION rednote_publish_excluded_job_has_recovery_evidence(
  candidate_workspace_id TEXT,
  candidate_notion_page_id TEXT,
  excluded_local_publish_job_id UUID,
  excluded_publish_attempt_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
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
        OR job.authenticated_account_id IS NOT NULL
        OR job.authenticated_account_at IS NOT NULL
        OR job.xsec_accessible_at IS NOT NULL
        OR job.public_index_status IS NOT NULL
        OR job.public_index_checked_at IS NOT NULL
        OR job.provider_restriction_status IS NOT NULL
        OR job.provider_restriction_reported_at IS NOT NULL
        OR (
          (
            job.receipt_contract_version IS NOT NULL
            OR job.receipt_outcome IS NOT NULL
            OR job.receipt_acknowledged_at IS NOT NULL
          )
          AND (
            job.status = 'failed'
            AND job.receipt_contract_version = 'rednote-worker-result/v2'
            AND job.receipt_outcome = 'rejected'
            AND job.receipt_acknowledged_at IS NOT NULL
          ) IS NOT TRUE
        )
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
  )
$$;

CREATE OR REPLACE FUNCTION rednote_publish_recovery_revision_blockers(
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
  SELECT blocker.*
  FROM rednote_publish_revision_blockers(
    candidate_workspace_id,
    candidate_notion_page_id,
    candidate_revision,
    excluded_batch_item_id,
    excluded_local_publish_job_id,
    excluded_publish_attempt_id
  ) blocker
  WHERE blocker.lifecycle_state <> 'excluded_local_job:evidence'

  UNION ALL

  SELECT
    candidate_notion_page_id,
    excluded_local_publish_job_id::text,
    'excluded_local_job:evidence'
  WHERE rednote_publish_excluded_job_has_recovery_evidence(
    candidate_workspace_id,
    candidate_notion_page_id,
    excluded_local_publish_job_id,
    excluded_publish_attempt_id
  )
$$;

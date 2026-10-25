-- Editorial recovery only. A newer packet still needs its own explicit consent.
-- Preserve both the original failed attempt and the existing form-rejection policy.
CREATE OR REPLACE FUNCTION rednote_ready_x3_pre_submit_rejection_is_proven(
  p_workspace TEXT, p_job UUID, p_attempt UUID
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM local_publish_jobs job
    JOIN rednote_publish_attempts attempt
      ON attempt.source_local_publish_job_id=job.id
      AND attempt.workspace_id=job.workspace_id
      AND attempt.source_notion_page_id=job.notion_page_id
    WHERE job.workspace_id=p_workspace AND job.id=p_job AND attempt.id=p_attempt
      AND job.status='failed' AND job.batch_item_id IS NULL
      AND (
        (
          job.error_code='STAGED_FORM_CHANGED'
          AND job.error_message='Creator is no longer showing the staged publish form'
          AND job.staged_at IS NOT NULL
          AND job.dispatch_authorized_at >= job.staged_at
          AND job.receipt_acknowledged_at >= job.dispatch_authorized_at
          AND attempt.dispatch_authorized_at=job.dispatch_authorized_at
          AND EXISTS (
            SELECT 1 FROM rednote_publish_attempt_events e
            WHERE e.attempt_id=attempt.id AND e.event_type='execution_started'
              AND e.actor_type='worker' AND e.occurred_at=attempt.dispatch_authorized_at
          )
        ) OR (
          job.error_code='NOT_LOGGED_IN'
          AND job.error_message='RedNote creator login is required in the persistent browser profile'
          AND job.staged_at IS NULL AND job.dispatch_authorized_at IS NULL
          AND attempt.dispatch_authorized_at IS NULL
          AND attempt.worker_run_id IS NULL AND attempt.playwright_run_id IS NULL
          AND job.receipt_acknowledged_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM rednote_publish_attempt_events e
            WHERE e.attempt_id=attempt.id AND e.event_type='execution_started'
          )
        )
      )
      AND job.receipt_contract_version='rednote-worker-result/v2'
      AND job.receipt_outcome='rejected'
      AND job.completed_at >= job.receipt_acknowledged_at
      AND job.claim_token IS NULL
      AND job.dispatched_at IS NULL AND job.verified_at IS NULL
      AND job.reconciled_at IS NULL AND job.note_id IS NULL AND job.share_url IS NULL
      AND job.success_attestation_id IS NULL
      AND job.external_disposition_request_id IS NULL
      AND job.ready_x3_schedule_edit_hold_id IS NULL
      AND job.authenticated_account_id IS NULL AND job.authenticated_account_at IS NULL
      AND job.xsec_accessible_at IS NULL AND job.public_index_status IS NULL
      AND job.public_index_checked_at IS NULL AND job.provider_restriction_status IS NULL
      AND job.provider_restriction_reported_at IS NULL
      AND job.snapshot->>'automationConsent'='ready_x3'
      AND job.snapshot->>'notionPageId'=job.notion_page_id
      AND job.snapshot->>'notionLastEditedTime'=attempt.payload_revision
      AND (job.snapshot->>'publishAt')::timestamptz=attempt.target_publish_at
      AND attempt.authorization_kind='ready_x3' AND attempt.executor_type='worker'
      AND attempt.approved_at IS NOT NULL AND NOT attempt.active
      AND attempt.terminal_outcome='known_failed'
      AND attempt.receipt_lookup_state='not_required'
      AND attempt.superseded_by_attempt_id IS NULL
      AND attempt.ready_x3_schedule_edit_hold_id IS NULL
      AND attempt.payload_digest ~ '^[a-f0-9]{64}$'
      AND attempt.frozen_payload->>'payloadDigest'=attempt.payload_digest
      AND attempt.frozen_payload->>'payloadRevision'=attempt.payload_revision
      AND attempt.frozen_payload->>'sourceNotionPageId'=job.notion_page_id
      AND attempt.frozen_payload->>'sourceLocalPublishJobId'=job.id::text
      AND attempt.frozen_payload->'browserPayload'->>'sourcePostId'=job.notion_page_id
      AND attempt.frozen_payload->'browserPayload'->>'timingMode'='scheduled'
      AND (attempt.frozen_payload->'browserPayload'->>'targetPublishAt')::timestamptz=attempt.target_publish_at
      AND (attempt.frozen_payload->'browserPayload'->>'scheduledDate')::timestamptz=attempt.target_publish_at
      AND (SELECT COUNT(*) FROM rednote_publish_attempts a
           WHERE a.source_local_publish_job_id=job.id)=1
      AND NOT EXISTS (
        SELECT 1 FROM rednote_publish_attempt_events e
        WHERE e.attempt_id=attempt.id AND e.event_type='execution_evidence'
      )
      AND NOT EXISTS (
        SELECT 1 FROM rednote_publish_attempt_receipts r WHERE r.attempt_id=attempt.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM rednote_publication_evidence e
        WHERE e.workspace_id=job.workspace_id
          AND (e.local_publish_job_id=job.id OR e.attempt_id=attempt.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM local_publish_job_success_attestations a
        WHERE a.local_publish_job_id=job.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM external_post_reconciliations r
        WHERE r.workspace_id=job.workspace_id AND r.notion_page_id=job.notion_page_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM manual_reconciliation_requests r
        WHERE r.workspace_id=job.workspace_id AND r.notion_page_id=job.notion_page_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM plan_operator_scheduled_posts s
        WHERE s.workspace_id=job.workspace_id AND s.notion_page_id=job.notion_page_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM ready_x3_schedule_edit_operations h
        WHERE h.workspace_id=job.workspace_id
          AND h.source_notion_page_id=job.notion_page_id AND h.state='prepared'
      )
  ), FALSE)
$$;

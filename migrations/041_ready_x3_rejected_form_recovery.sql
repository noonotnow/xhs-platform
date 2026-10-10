-- A v2 pre-submit rejection is not provider acceptance. Preserve the failed
-- execution and its negative receipt before opening a new execution generation
-- of the SAME publishing operation. Never reset an immutable failed attempt.
CREATE TABLE rednote_ready_x3_form_recoveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  local_publish_job_id UUID NOT NULL,
  failed_attempt_id UUID NOT NULL UNIQUE
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  replacement_attempt_id UUID NOT NULL UNIQUE
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  payload_revision TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  target_publish_at TIMESTAMPTZ NOT NULL,
  prior_rejection JSONB NOT NULL CHECK (jsonb_typeof(prior_rejection) = 'object'),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, local_publish_job_id)
    REFERENCES local_publish_jobs(workspace_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION prevent_ready_x3_form_recovery_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ready x3 form recovery history is append-only';
END;
$$;
CREATE TRIGGER ready_x3_form_recoveries_append_only
BEFORE UPDATE OR DELETE ON rednote_ready_x3_form_recoveries
FOR EACH ROW EXECUTE FUNCTION prevent_ready_x3_form_recovery_mutation();

CREATE FUNCTION recover_ready_x3_rejected_form(
  p_workspace TEXT, p_job UUID, p_attempt UUID, p_source TEXT,
  p_revision TEXT, p_digest TEXT, p_target TIMESTAMPTZ, p_actor TEXT
) RETURNS TABLE(recovery_id UUID, replacement_attempt_id UUID, already_recovered BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE
  job local_publish_jobs%ROWTYPE;
  failed rednote_publish_attempts%ROWTYPE;
  prior rednote_ready_x3_form_recoveries%ROWTYPE;
  replacement UUID := gen_random_uuid();
  recovery UUID := gen_random_uuid();
BEGIN
  IF p_workspace IS NULL OR length(p_workspace) NOT BETWEEN 1 AND 128
     OR p_job IS NULL OR p_attempt IS NULL OR p_source IS NULL OR p_source = ''
     OR p_revision IS NULL OR p_revision = ''
     OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
     OR p_target IS NULL OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid exact-packet recovery identity' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace || ':' || p_source, 0));
  SELECT * INTO prior FROM rednote_ready_x3_form_recoveries
    WHERE workspace_id=p_workspace AND local_publish_job_id=p_job
      AND failed_attempt_id=p_attempt;
  IF FOUND THEN
    IF prior.payload_revision IS DISTINCT FROM p_revision
       OR prior.payload_digest IS DISTINCT FROM p_digest
       OR prior.target_publish_at IS DISTINCT FROM p_target
       OR NOT EXISTS (
         SELECT 1 FROM rednote_publish_attempts a
         WHERE a.id=prior.failed_attempt_id AND a.source_notion_page_id=p_source
       ) THEN
      RAISE EXCEPTION 'Recovery replay identity changed' USING ERRCODE='23514';
    END IF;
    RETURN QUERY SELECT prior.id, prior.replacement_attempt_id, TRUE;
    RETURN;
  END IF;
  SELECT * INTO job FROM local_publish_jobs
    WHERE workspace_id=p_workspace AND id=p_job AND notion_page_id=p_source
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recovery job identity mismatch' USING ERRCODE='23514';
  END IF;
  SELECT * INTO failed FROM rednote_publish_attempts
    WHERE workspace_id=p_workspace AND id=p_attempt
      AND source_local_publish_job_id=p_job AND source_notion_page_id=p_source
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recovery attempt identity mismatch' USING ERRCODE='23514';
  END IF;
  -- Exact error + acknowledged worker contract together attest that publish
  -- preflight stopped before the submit control. Unknown outcomes stay closed.
  IF NOT COALESCE(
    job.status='failed' AND job.batch_item_id IS NULL
    AND job.error_code='STAGED_FORM_CHANGED'
    AND job.error_message='Creator is no longer showing the staged publish form'
    AND job.receipt_contract_version='rednote-worker-result/v2'
    AND job.receipt_outcome='rejected'
    AND job.staged_at IS NOT NULL AND job.dispatch_authorized_at IS NOT NULL
    AND job.receipt_acknowledged_at >= job.dispatch_authorized_at
    AND job.completed_at >= job.receipt_acknowledged_at
    AND job.claim_token IS NULL
    AND job.dispatched_at IS NULL AND job.verified_at IS NULL
    AND job.reconciled_at IS NULL AND job.note_id IS NULL AND job.share_url IS NULL
    AND job.success_attestation_id IS NULL
    AND job.external_disposition_request_id IS NULL
    AND job.ready_x3_schedule_edit_hold_id IS NULL
    AND job.snapshot->>'automationConsent'='ready_x3'
    AND job.snapshot->>'notionPageId'=p_source
    AND job.snapshot->>'notionLastEditedTime'=p_revision
    AND (job.snapshot->>'publishAt')::timestamptz=p_target
    AND failed.authorization_kind='ready_x3'
    AND failed.executor_type='worker'
    AND failed.approved_at IS NOT NULL AND NOT failed.active
    AND failed.terminal_outcome='known_failed'
    AND failed.receipt_lookup_state='not_required'
    AND failed.superseded_by_attempt_id IS NULL
    AND failed.ready_x3_schedule_edit_hold_id IS NULL
    AND failed.dispatch_authorized_at=job.dispatch_authorized_at
    AND failed.payload_revision=p_revision AND failed.payload_digest=p_digest
    AND failed.frozen_payload->>'payloadRevision'=p_revision
    AND failed.frozen_payload->>'payloadDigest'=p_digest
    AND failed.frozen_payload->>'sourceNotionPageId'=p_source
    AND failed.frozen_payload->>'sourceLocalPublishJobId'=p_job::text
    AND failed.frozen_payload->'browserPayload'->>'sourcePostId'=p_source
    AND failed.frozen_payload->'browserPayload'->>'timingMode'='scheduled'
    AND (failed.frozen_payload->'browserPayload'->>'targetPublishAt')::timestamptz=p_target
    AND (failed.frozen_payload->'browserPayload'->>'scheduledDate')::timestamptz=p_target
    AND failed.target_publish_at=p_target
    AND p_target > clock_timestamp() + interval '10 minutes'
    AND EXISTS (
      SELECT 1 FROM rednote_publish_attempt_events e
      WHERE e.attempt_id=p_attempt AND e.event_type='execution_started'
        AND e.actor_type='worker' AND e.occurred_at=failed.dispatch_authorized_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publish_attempt_events e
      WHERE e.attempt_id=p_attempt AND e.event_type='execution_evidence'
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publish_attempt_receipts r WHERE r.attempt_id=p_attempt
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publication_evidence e
      WHERE e.workspace_id=p_workspace
        AND (e.local_publish_job_id=p_job OR e.attempt_id=p_attempt)
    )
    AND NOT EXISTS (
      SELECT 1 FROM local_publish_job_success_attestations s WHERE s.local_publish_job_id=p_job
    )
    AND NOT EXISTS (
      SELECT 1 FROM manual_reconciliation_requests r
      WHERE r.workspace_id=p_workspace AND r.source_local_job_id=p_job
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_post_reconciliations r
      WHERE r.workspace_id=p_workspace AND r.notion_page_id=p_source
    )
    AND NOT EXISTS (
      SELECT 1 FROM plan_operator_scheduled_posts s
      WHERE s.workspace_id=p_workspace AND s.notion_page_id=p_source
    )
    AND NOT EXISTS (
      SELECT 1 FROM ready_x3_schedule_edit_operations h
      WHERE h.workspace_id=p_workspace AND h.source_notion_page_id=p_source AND h.state='prepared'
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publish_attempts a
      WHERE a.workspace_id=p_workspace AND a.source_notion_page_id=p_source AND a.active
    )
    AND NOT EXISTS (
      SELECT 1 FROM local_publish_jobs j
      WHERE j.workspace_id=p_workspace AND j.notion_page_id=p_source AND j.id<>p_job
        AND rednote_publish_local_job_allows_newer_revision(
          p_workspace,p_source,j.id,p_revision
        ) IS NOT TRUE
    ), FALSE) THEN
    RAISE EXCEPTION 'Rejected form is not safe for exact-version recovery' USING ERRCODE='23514';
  END IF;

  INSERT INTO rednote_publish_attempts (
    id, workspace_id, idempotency_key, contract_revision, source_notion_page_id,
    source_local_publish_job_id, frozen_payload, payload_digest, payload_revision,
    executor_type, executor_kind, executor_id, target_publish_at, requested_at,
    approved_at, active, authorization_kind, late_fallback_policy, supersedes_attempt_id
  ) VALUES (
    replacement, failed.workspace_id, gen_random_uuid(), failed.contract_revision,
    failed.source_notion_page_id, failed.source_local_publish_job_id,
    failed.frozen_payload, failed.payload_digest, failed.payload_revision,
    failed.executor_type, failed.executor_kind, failed.executor_id, failed.target_publish_at,
    failed.requested_at, failed.approved_at, TRUE, failed.authorization_kind,
    failed.late_fallback_policy, failed.id
  );
  UPDATE rednote_publish_attempts SET superseded_by_attempt_id=replacement WHERE id=failed.id;
  INSERT INTO rednote_ready_x3_form_recoveries (
    id,workspace_id,local_publish_job_id,failed_attempt_id,replacement_attempt_id,
    payload_revision,payload_digest,target_publish_at,prior_rejection,actor_id
  ) VALUES (
    recovery,p_workspace,p_job,p_attempt,replacement,p_revision,p_digest,p_target,
    jsonb_build_object(
      'errorCode',job.error_code,'errorMessage',job.error_message,
      'receiptContractVersion',job.receipt_contract_version,
      'receiptOutcome',job.receipt_outcome,'receiptAcknowledgedAt',job.receipt_acknowledged_at,
      'stagedAt',job.staged_at,'activationConsumedAt',job.dispatch_authorized_at,
      'completedAt',job.completed_at
    ),p_actor
  );
  -- Only the mutable job projection is opened for the replacement generation.
  -- The consumed old activation and failed terminal attempt remain immutable.
  UPDATE local_publish_jobs SET
    status='queued', claim_token=NULL, claimed_at=NULL, claim_expires_at=NULL,
    staged_at=NULL, dispatch_authorized_at=NULL, completed_at=NULL,
    error_code=NULL,error_message=NULL,receipt_contract_version=NULL,
    receipt_outcome=NULL,receipt_acknowledged_at=NULL,updated_at=CURRENT_TIMESTAMP
  WHERE id=p_job AND workspace_id=p_workspace;
  INSERT INTO rednote_publish_attempt_events (
    attempt_id,event_type,occurred_at,actor_type,actor_id,diagnostics
  ) VALUES
    (p_attempt,'administrative_recovery',CURRENT_TIMESTAMP,'admin',p_actor,
     jsonb_build_object('kind','rejected_form_preserved','recoveryId',recovery)),
    (replacement,'attempt_created',CURRENT_TIMESTAMP,'admin',p_actor,
     jsonb_build_object('kind','exact_version_recovery','recoveryId',recovery));
  RETURN QUERY SELECT recovery,replacement,FALSE;
END;
$$;

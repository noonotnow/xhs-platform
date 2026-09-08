CREATE OR REPLACE FUNCTION terminal_expired_batch_claim_stable_json(value JSONB)
RETURNS TEXT AS $$
DECLARE
  result TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        string_agg(
          to_jsonb(entry.key)::text || ':' ||
            terminal_expired_batch_claim_stable_json(entry.value),
          ',' ORDER BY entry.key COLLATE "C"
        ),
        ''
      ) || '}'
      INTO result
      FROM jsonb_each(value) AS entry;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(
        string_agg(
          terminal_expired_batch_claim_stable_json(entry.value),
          ',' ORDER BY entry.ordinality
        ),
        ''
      ) || ']'
      INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(value, ordinality);
    ELSE
      result := value::text;
  END CASE;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION terminal_expired_batch_claim_digest(value JSONB)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT encode(
    sha256(convert_to(terminal_expired_batch_claim_stable_json(value), 'UTF8')),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION terminal_expired_batch_claim_manifest_digest(
  notion_page_id TEXT,
  item_hash TEXT,
  dispatch_mode TEXT,
  late_by_seconds INTEGER
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT encode(
    sha256(convert_to(
      '[{"notionPageId":' || to_jsonb(notion_page_id)::text ||
      ',"itemHash":' || to_jsonb(item_hash)::text ||
      ',"dispatchMode":' || to_jsonb(dispatch_mode)::text ||
      ',"lateBySeconds":' || to_jsonb(late_by_seconds)::text || '}]',
      'UTF8'
    )),
    'hex'
  )
$$;

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
      SELECT 1 FROM rednote_publish_attempt_events event
      WHERE event.attempt_id = OLD.id
        AND event.event_type = 'execution_started'
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publish_attempt_receipts receipt
      WHERE receipt.attempt_id = OLD.id
    );
  expired_claim_reclassification BOOLEAN :=
    current_setting('app.expired_batch_claim_reclassification', true) = 'on'
    AND OLD.authorization_kind = 'ready_x3'
    AND NEW.authorization_kind IS NULL
    AND OLD.late_fallback_policy =
      '{"action":"post_now","maxLateMinutes":30}'::jsonb
    AND NEW.late_fallback_policy IS NULL
    AND OLD.approved_at IS NOT NULL
    AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at
    AND OLD.terminal_outcome IS NULL
    AND NEW.terminal_outcome IS NULL
    AND OLD.terminal_at IS NULL
    AND NEW.terminal_at IS NULL
    AND OLD.receipt_lookup_state = 'pending'
    AND NEW.receipt_lookup_state = 'pending'
    AND OLD.active
    AND NEW.active
    AND OLD.dispatch_authorized_at IS NULL
    AND NEW.dispatch_authorized_at IS NULL
    AND OLD.worker_run_id IS NULL
    AND NEW.worker_run_id IS NULL
    AND OLD.playwright_run_id IS NULL
    AND NEW.playwright_run_id IS NULL
    AND OLD.superseded_by_attempt_id IS NULL
    AND NEW.superseded_by_attempt_id IS NULL
    AND OLD.claim_token IS NOT NULL
    AND NEW.claim_token IS NULL
    AND OLD.claim_expires_at IS NOT NULL
    AND OLD.claim_expires_at <= CURRENT_TIMESTAMP
    AND NEW.claim_expires_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM local_publish_jobs job
      JOIN rednote_publish_batch_items item
        ON item.id = job.batch_item_id
       AND item.local_publish_job_id = job.id
      JOIN rednote_publish_batches batch ON batch.id = item.batch_id
      WHERE job.id = OLD.source_local_publish_job_id
        AND job.workspace_id = OLD.workspace_id
        AND job.status = 'claimed'
        AND job.error_code IS NULL
        AND job.error_message IS NULL
        AND job.claim_token = OLD.claim_token
        AND job.claimed_at IS NOT NULL
        AND job.claim_expires_at = OLD.claim_expires_at
        AND job.claim_expires_at <= CURRENT_TIMESTAMP
        AND job.staged_at IS NULL
        AND job.dispatch_authorized_at IS NULL
        AND job.dispatched_at IS NULL
        AND job.verified_at IS NULL
        AND job.reconciled_at IS NULL
        AND job.completed_at IS NULL
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
        AND item.state = 'claimed'
        AND item.dispatch_mode = 'scheduled'
        AND batch.status IN ('approved', 'partially_approved')
        AND batch.approved_at IS NOT NULL
    )
    AND EXISTS (
      SELECT 1 FROM rednote_publish_attempt_events event
      WHERE event.attempt_id = OLD.id
        AND event.event_type = 'worker_claimed'
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publish_attempt_events event
      WHERE event.attempt_id = OLD.id
        AND event.event_type = 'execution_started'
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publish_attempt_receipts receipt
      WHERE receipt.attempt_id = OLD.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publication_evidence evidence
      WHERE evidence.workspace_id = OLD.workspace_id
        AND evidence.local_publish_job_id = OLD.source_local_publish_job_id
    );
  terminal_expired_claim_reclassification BOOLEAN :=
    current_setting(
      'app.terminal_expired_batch_claim_reclassification',
      true
    ) = 'on'
    AND OLD.authorization_kind = 'ready_x3'
    AND NEW.authorization_kind IS NULL
    AND OLD.late_fallback_policy =
      '{"action":"post_now","maxLateMinutes":30}'::jsonb
    AND NEW.late_fallback_policy IS NULL
    AND OLD.approved_at IS NOT NULL
    AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at
    AND OLD.terminal_outcome = 'known_failed'
    AND NEW.terminal_outcome IS NULL
    AND OLD.terminal_at IS NOT NULL
    AND NEW.terminal_at IS NULL
    AND OLD.receipt_lookup_state = 'not_required'
    AND NEW.receipt_lookup_state = 'pending'
    AND NEW.receipt_lookup_updated_at = CURRENT_TIMESTAMP
    AND NOT OLD.active
    AND NEW.active
    AND OLD.dispatch_authorized_at IS NULL
    AND NEW.dispatch_authorized_at IS NULL
    AND OLD.worker_run_id IS NULL
    AND NEW.worker_run_id IS NULL
    AND OLD.playwright_run_id IS NULL
    AND NEW.playwright_run_id IS NULL
    AND OLD.superseded_by_attempt_id IS NULL
    AND NEW.superseded_by_attempt_id IS NULL
    AND OLD.claim_token IS NOT NULL
    AND NEW.claim_token IS NULL
    AND OLD.claim_expires_at = OLD.terminal_at
    AND OLD.claim_expires_at <= CURRENT_TIMESTAMP
    AND NEW.claim_expires_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM local_publish_jobs job
      JOIN rednote_publish_batch_items item
        ON item.id = job.batch_item_id
       AND item.local_publish_job_id = job.id
      JOIN rednote_publish_batches batch ON batch.id = item.batch_id
      WHERE job.id = OLD.source_local_publish_job_id
        AND job.workspace_id = OLD.workspace_id
        AND job.notion_page_id = OLD.source_notion_page_id
        AND job.status = 'failed'
        AND job.error_code = 'CLAIM_LEASE_EXPIRED'
        AND job.error_message =
          'The publish lease expired without a terminal result. Automatic dispatch is permanently closed; review the frozen attempt before operator handling or reconciliation.'
        AND job.claim_token IS NULL
        AND job.claim_attempts = 1
        AND job.claimed_at IS NOT NULL
        AND job.claim_expires_at = OLD.claim_expires_at
        AND job.completed_at = OLD.terminal_at
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
        AND item.state = 'queued'
        AND item.dispatch_mode = 'scheduled'
        AND item.notion_page_id = OLD.source_notion_page_id
        AND item.snapshot = job.snapshot
        AND item.snapshot->>'notionPageId' = OLD.source_notion_page_id
        AND item.snapshot->>'notionLastEditedTime' = OLD.payload_revision
        AND item.item_hash =
          terminal_expired_batch_claim_digest(item.snapshot)
        AND OLD.frozen_payload->>'contractRevision' = OLD.contract_revision
        AND OLD.frozen_payload->>'sourceNotionPageId' =
          OLD.source_notion_page_id
        AND OLD.frozen_payload->>'sourceLocalPublishJobId' =
          OLD.source_local_publish_job_id::text
        AND OLD.frozen_payload->>'payloadRevision' = OLD.payload_revision
        AND OLD.frozen_payload->>'payloadDigest' = OLD.payload_digest
        AND OLD.payload_digest = terminal_expired_batch_claim_digest(
          OLD.frozen_payload->'browserPayload'
        )
        AND OLD.frozen_payload->'browserPayload'->>'sourcePostId' =
          OLD.source_notion_page_id
        AND OLD.frozen_payload->'browserPayload'->>'expectedAccountId' =
          item.snapshot->>'expectedAccountId'
        AND OLD.frozen_payload->'browserPayload'->>'title' =
          item.snapshot->>'title'
        AND OLD.frozen_payload->'browserPayload'->>'caption' =
          item.snapshot->>'caption'
        AND OLD.frozen_payload->'browserPayload'->'tags' =
          item.snapshot->'tags'
        AND OLD.frozen_payload->'browserPayload'->>'publishMode' =
          item.snapshot->>'mediaType'
        AND OLD.frozen_payload->'browserPayload'->>'scheduledDate' =
          item.snapshot->>'publishAt'
        AND OLD.frozen_payload->'browserPayload'->>'targetPublishAt' =
          item.snapshot->>'publishAt'
        AND OLD.frozen_payload->'browserPayload'->>'timingMode' = 'scheduled'
        AND jsonb_array_length(item.snapshot->'media') BETWEEN 1 AND 18
        AND item.snapshot->'media'->0->>'type' =
          item.snapshot->>'mediaType'
        AND item.snapshot->'media'->0->>'url' =
          item.snapshot->>'mediaUrl'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(item.snapshot->'media') AS media(value)
          WHERE media.value->>'type' IS DISTINCT FROM
            item.snapshot->>'mediaType'
        )
        AND CASE
          WHEN jsonb_typeof(
            OLD.frozen_payload->'browserPayload'->'mediaAssets'
          ) = 'array'
          AND jsonb_typeof(item.snapshot->'media') = 'array'
          THEN (
            SELECT jsonb_agg(
              jsonb_build_object(
                'type', asset.value->>'mediaType',
                'url', asset.value->>'deliveryUrl'
              )
              ORDER BY asset.ordinality
            )
            FROM jsonb_array_elements(
              OLD.frozen_payload->'browserPayload'->'mediaAssets'
            ) WITH ORDINALITY AS asset(value, ordinality)
          ) = (
            SELECT jsonb_agg(
              jsonb_build_object(
                'type', media.value->>'type',
                'url', media.value->>'url'
              )
              ORDER BY media.ordinality
            )
            FROM jsonb_array_elements(item.snapshot->'media')
              WITH ORDINALITY AS media(value, ordinality)
          )
          ELSE FALSE
        END
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(item.snapshot->'media') AS media(value)
          WHERE media.value->>'identity' IS DISTINCT FROM
            terminal_expired_batch_claim_digest(
              jsonb_build_object(
                'type', media.value->>'type',
                'url', media.value->>'url'
              )
            )
        )
        AND (
          item.snapshot->>'mediaType' <> 'video'
          OR OLD.frozen_payload->'browserPayload'->'coverAsset'->>'deliveryUrl' =
            item.snapshot->>'thumbnailUrl'
        )
        AND batch.status IN ('approved', 'partially_approved')
        AND batch.approved_at IS NOT NULL
        AND batch.approved_at = OLD.approved_at
        AND (
          SELECT count(*) FROM rednote_publish_batch_items sibling
          WHERE sibling.batch_id = batch.id
        ) = 1
        AND batch.manifest_hash =
          terminal_expired_batch_claim_manifest_digest(
            item.notion_page_id,
            item.item_hash,
            item.dispatch_mode,
            item.late_by_seconds
          )
    )
    AND OLD.receipt_lookup_updated_at = OLD.terminal_at
    AND (
      SELECT count(*) FROM rednote_publish_attempts sibling_attempt
      WHERE sibling_attempt.workspace_id = OLD.workspace_id
        AND sibling_attempt.source_local_publish_job_id =
          OLD.source_local_publish_job_id
    ) = 1
    AND (
      SELECT count(*) FROM rednote_publish_attempt_events event
      WHERE event.attempt_id = OLD.id
    ) = 3
    AND (
      SELECT count(*) FROM rednote_publish_attempt_events event
      WHERE event.attempt_id = OLD.id
        AND event.event_type = 'attempt_created'
    ) = 1
    AND (
      SELECT count(*) FROM rednote_publish_attempt_events event
      WHERE event.attempt_id = OLD.id
        AND event.event_type = 'worker_claimed'
    ) = 1
    AND (
      SELECT count(*) FROM rednote_publish_attempt_events event
      WHERE event.attempt_id = OLD.id
        AND event.event_type = 'terminal_outcome_recorded'
        AND event.actor_type = 'admin'
        AND event.actor_id = 'local_publish_lease_recovery'
        AND event.occurred_at = OLD.terminal_at
    ) = 1
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publish_attempt_events event
      WHERE event.attempt_id = OLD.id
        AND event.event_type = 'execution_started'
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publish_attempt_receipts receipt
      WHERE receipt.attempt_id = OLD.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publication_evidence evidence
      WHERE evidence.workspace_id = OLD.workspace_id
        AND (
          evidence.local_publish_job_id = OLD.source_local_publish_job_id
          OR evidence.attempt_id = OLD.id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM local_publish_job_success_attestations attestation
      WHERE attestation.local_publish_job_id =
        OLD.source_local_publish_job_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM local_publish_job_success_attestation_release_acks acknowledgement
      JOIN local_publish_job_success_attestations attestation
        ON attestation.id = acknowledgement.success_attestation_id
      WHERE attestation.local_publish_job_id =
        OLD.source_local_publish_job_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM manual_reconciliation_requests reconciliation
      WHERE reconciliation.workspace_id = OLD.workspace_id
        AND reconciliation.source_local_job_id = OLD.source_local_publish_job_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_post_reconciliations reconciliation
      WHERE reconciliation.workspace_id = OLD.workspace_id
        AND reconciliation.notion_page_id = OLD.source_notion_page_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM plan_operator_scheduled_posts operator_post
      WHERE operator_post.workspace_id = OLD.workspace_id
        AND operator_post.notion_page_id = OLD.source_notion_page_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM rednote_publish_job_recoveries recovery
      WHERE recovery.local_publish_job_id =
        OLD.source_local_publish_job_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM local_publish_queue_quarantine_items quarantine
      WHERE quarantine.local_publish_job_id =
        OLD.source_local_publish_job_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM local_publish_jobs other_job
      WHERE other_job.workspace_id = OLD.workspace_id
        AND other_job.notion_page_id = OLD.source_notion_page_id
        AND other_job.id <> OLD.source_local_publish_job_id
        AND other_job.status NOT IN ('reconciled', 'succeeded', 'failed')
    );
BEGIN
  IF OLD.authorization_kind IS NOT NULL
     AND (
       NEW.authorization_kind IS DISTINCT FROM OLD.authorization_kind
       OR NEW.late_fallback_policy IS DISTINCT FROM OLD.late_fallback_policy
     )
     AND NOT batch_reclassification
     AND NOT expired_claim_reclassification
     AND NOT terminal_expired_claim_reclassification THEN
    RAISE EXCEPTION 'Ready x3 authorization is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_terminal_expired_batch_claim_reset()
RETURNS trigger AS $$
BEGIN
  IF OLD.terminal_outcome = 'known_failed'
     AND NEW.terminal_outcome IS NULL
     AND EXISTS (
       SELECT 1
       FROM local_publish_jobs job
       WHERE job.id = OLD.source_local_publish_job_id
         AND job.workspace_id = OLD.workspace_id
         AND job.status = 'failed'
         AND job.error_code = 'CLAIM_LEASE_EXPIRED'
         AND job.error_message =
           'The publish lease expired without a terminal result. Automatic dispatch is permanently closed; review the frozen attempt before operator handling or reconciliation.'
     )
     AND NOT (
       current_setting(
         'app.terminal_expired_batch_claim_reclassification',
         true
       ) = 'on'
       AND OLD.authorization_kind = 'ready_x3'
       AND NEW.authorization_kind IS NULL
       AND OLD.late_fallback_policy =
         '{"action":"post_now","maxLateMinutes":30}'::jsonb
       AND NEW.late_fallback_policy IS NULL
     ) THEN
    RAISE EXCEPTION
      'terminal expired batch claim reset requires exact authorization reclassification';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS terminal_expired_batch_claim_reset
  ON rednote_publish_attempts;
CREATE TRIGGER terminal_expired_batch_claim_reset
BEFORE UPDATE ON rednote_publish_attempts
FOR EACH ROW
EXECUTE FUNCTION guard_terminal_expired_batch_claim_reset();

CREATE OR REPLACE FUNCTION terminal_expired_batch_claim_reclassification_guard_revision()
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$ SELECT '029'::TEXT $$;

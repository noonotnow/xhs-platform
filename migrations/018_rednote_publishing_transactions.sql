ALTER TABLE rednote_publish_attempts
  ADD COLUMN IF NOT EXISTS source_post_revision TEXT NOT NULL
    CHECK (char_length(source_post_revision) BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS claim_source_status TEXT,
  ADD COLUMN IF NOT EXISTS claim_source_post_revision TEXT,
  ADD COLUMN IF NOT EXISTS claim_packet_authorized_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS operator_resolution_started_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS operator_resolution_completed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE rednote_publish_attempts
  ADD CONSTRAINT rednote_publish_attempts_payload_revision_v1_check
    CHECK (payload_revision = 'rednote-browser-payload/v1'),
  ADD CONSTRAINT rednote_publish_attempts_claim_source_check CHECK (
    (
      activated_at IS NULL
      AND NOT active
      AND claim_source_status IS NULL
      AND claim_source_post_revision IS NULL
      AND claim_packet_authorized_at IS NULL
    )
    OR (
      executor_type = 'worker'
      AND activated_at IS NOT NULL
      AND claim_source_status IS NOT NULL
      AND claim_source_status = 'Ready'
      AND claim_source_post_revision IS NOT NULL
      AND claim_source_post_revision IS NOT DISTINCT FROM source_post_revision
      AND claim_packet_authorized_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT rednote_publish_attempts_operator_resolution_check CHECK (
    (
      operator_resolution_started_at IS NULL
      AND operator_resolution_completed_at IS NULL
    )
    OR (
      executor_type = 'operator'
      AND terminal_outcome IS NOT NULL
      AND terminal_outcome = 'accepted'
      AND NOT active
      AND operator_resolution_started_at IS NOT NULL
      AND (
        operator_resolution_completed_at IS NULL
        OR operator_resolution_completed_at >= operator_resolution_started_at
      )
    )
  );

ALTER TABLE rednote_publish_attempts
  DROP CONSTRAINT IF EXISTS rednote_publish_attempts_superseded_by_attempt_id_fkey,
  ADD CONSTRAINT rednote_publish_attempts_superseded_by_attempt_id_fkey
    FOREIGN KEY (superseded_by_attempt_id)
    REFERENCES rednote_publish_attempts(id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX IF NOT EXISTS rednote_publish_attempts_operator_resolution_idx
  ON rednote_publish_attempts (source_notion_page_id)
  WHERE operator_resolution_started_at IS NOT NULL
    AND operator_resolution_completed_at IS NULL;

CREATE TABLE IF NOT EXISTS rednote_publish_attempt_requests (
  requester TEXT NOT NULL CHECK (requester IN ('create', 'plan', 'admin')),
  idempotency_key UUID NOT NULL,
  raw_request_digest TEXT NOT NULL CHECK (raw_request_digest ~ '^[a-f0-9]{64}$'),
  attempt_id UUID NOT NULL UNIQUE
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (requester, idempotency_key)
);

CREATE TABLE IF NOT EXISTS rednote_publish_post_mutations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  source_notion_page_id TEXT NOT NULL
    CHECK (char_length(source_notion_page_id) > 0),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN (
    'worker_claim', 'accepted', 'known_failed', 'outcome_unknown',
    'operator_supersession', 'receipt_capture'
  )),
  expected_active_attempt_id TEXT,
  expected_source_post_revision TEXT,
  expected_status TEXT CHECK (
    expected_status IS NULL
    OR expected_status IN ('Not started', 'Draft', 'In progress', 'Ready', 'Published')
  ),
  expected_next_action TEXT CHECK (
    expected_next_action IS NULL
    OR expected_next_action IN (
      'Develop packet', 'Ready for publication', 'Resolve attempt',
      'Backfill receipt', 'Backfill metrics', 'Reconciled', 'Blocked'
    )
  ),
  expected_publish_execution TEXT CHECK (
    expected_publish_execution IS NULL
    OR expected_publish_execution IN (
      'Not attempted', 'Worker claimed', 'Worker batched',
      'Worker batch failed', 'Operator scheduled'
    )
  ),
  desired_active_attempt_id TEXT,
  desired_status TEXT CHECK (
    desired_status IS NULL
    OR desired_status IN ('Not started', 'Draft', 'In progress', 'Ready', 'Published')
  ),
  desired_next_action TEXT CHECK (
    desired_next_action IS NULL
    OR desired_next_action IN (
      'Develop packet', 'Ready for publication', 'Resolve attempt',
      'Backfill receipt', 'Backfill metrics', 'Reconciled', 'Blocked'
    )
  ),
  desired_publish_execution TEXT CHECK (
    desired_publish_execution IS NULL
    OR desired_publish_execution IN (
      'Not attempted', 'Worker claimed', 'Worker batched',
      'Worker batch failed', 'Operator scheduled'
    )
  ),
  desired_rednote_url TEXT,
  desired_rednote_note_id TEXT,
  desired_platform_publish_time TIMESTAMP WITH TIME ZONE,
  claim_worker_run_id TEXT,
  claim_playwright_run_id TEXT,
  claim_occurred_at TIMESTAMP WITH TIME ZONE,
  claim_actor_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'applied', 'conflict')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(diagnostics) = 'object'),
  last_error_code TEXT,
  last_error_message TEXT,
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  applied_at TIMESTAMP WITH TIME ZONE,
  conflict_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT rednote_publish_post_mutations_receipt_identity_check CHECK (
    (desired_rednote_url IS NULL) = (desired_rednote_note_id IS NULL)
  ),
  CONSTRAINT rednote_publish_post_mutations_claim_context_check CHECK (
    (
      mutation_kind = 'worker_claim'
      AND claim_worker_run_id IS NOT NULL
      AND char_length(claim_worker_run_id) > 0
      AND claim_occurred_at IS NOT NULL
      AND claim_actor_id IS NOT NULL
      AND char_length(claim_actor_id) > 0
    )
    OR (
      mutation_kind <> 'worker_claim'
      AND claim_worker_run_id IS NULL
      AND claim_playwright_run_id IS NULL
      AND claim_occurred_at IS NULL
      AND claim_actor_id IS NULL
    )
  ),
  CONSTRAINT rednote_publish_post_mutations_state_time_check CHECK (
    (state = 'pending' AND applied_at IS NULL AND conflict_at IS NULL)
    OR (state = 'applied' AND applied_at IS NOT NULL)
    OR (state = 'conflict' AND conflict_at IS NOT NULL AND applied_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS rednote_publish_post_mutations_unresolved_idx
  ON rednote_publish_post_mutations (source_notion_page_id)
  WHERE state IN ('pending', 'conflict');

CREATE INDEX IF NOT EXISTS rednote_publish_post_mutations_due_idx
  ON rednote_publish_post_mutations (state, last_attempt_at, created_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS rednote_publish_post_mutations_attempt_idx
  ON rednote_publish_post_mutations (attempt_id, created_at);

CREATE OR REPLACE FUNCTION guard_rednote_publish_attempt_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contract_revision IS DISTINCT FROM OLD.contract_revision
     OR NEW.source_notion_page_id IS DISTINCT FROM OLD.source_notion_page_id
     OR NEW.source_post_revision IS DISTINCT FROM OLD.source_post_revision
     OR (
       OLD.activated_at IS NOT NULL
       AND (
         NEW.claim_source_status IS DISTINCT FROM OLD.claim_source_status
         OR NEW.claim_source_post_revision
           IS DISTINCT FROM OLD.claim_source_post_revision
         OR NEW.claim_packet_authorized_at
           IS DISTINCT FROM OLD.claim_packet_authorized_at
       )
     )
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
     OR NEW.operator_resolution_started_at
       IS DISTINCT FROM OLD.operator_resolution_started_at
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
     ) THEN
    RAISE EXCEPTION 'rednote publish attempt terminal outcome is immutable once set';
  END IF;

  IF NEW.receipt_lookup_state IS DISTINCT FROM OLD.receipt_lookup_state
     AND NOT (
       (OLD.receipt_lookup_state = 'pending'
        AND NEW.receipt_lookup_state IN ('not_found', 'found', 'not_required'))
       OR (OLD.receipt_lookup_state = 'not_found'
           AND NEW.receipt_lookup_state IN ('found', 'not_required'))
     ) THEN
    RAISE EXCEPTION 'invalid rednote publish attempt receipt lookup transition';
  END IF;

  IF NEW.receipt_lookup_updated_at < OLD.receipt_lookup_updated_at THEN
    RAISE EXCEPTION 'rednote publish attempt receipt lookup time cannot move backwards';
  END IF;

  IF NOT OLD.active AND NEW.active THEN
    IF OLD.activated_at IS NOT NULL
       OR NEW.activated_at IS NULL
       OR NEW.claim_source_status <> 'Ready'
       OR NEW.claim_source_post_revision <> OLD.source_post_revision
       OR NEW.claim_packet_authorized_at IS NULL
       OR NEW.executor_type <> 'worker'
       OR NEW.terminal_outcome IS NOT NULL
       OR NEW.superseded_by_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION 'rednote publish attempt cannot be reactivated';
    END IF;
  ELSIF NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'rednote publish attempt activation time is immutable';
  END IF;

  IF OLD.superseded_by_attempt_id IS NOT NULL
     AND NEW.superseded_by_attempt_id IS DISTINCT FROM OLD.superseded_by_attempt_id THEN
    RAISE EXCEPTION 'rednote publish attempt supersession is immutable once set';
  END IF;

  IF OLD.operator_resolution_completed_at IS NOT NULL
     AND NEW.operator_resolution_completed_at
       IS DISTINCT FROM OLD.operator_resolution_completed_at THEN
    RAISE EXCEPTION 'operator resolution ownership cannot be reactivated';
  END IF;
  IF OLD.operator_resolution_completed_at IS NULL
     AND NEW.operator_resolution_completed_at IS NOT NULL
     AND (
       OLD.operator_resolution_started_at IS NULL
       OR NEW.operator_resolution_completed_at < OLD.operator_resolution_started_at
     ) THEN
    RAISE EXCEPTION 'invalid operator resolution completion';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_rednote_publish_request_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rednote publish transaction requests are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_rednote_publish_post_mutation_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.source_notion_page_id IS DISTINCT FROM OLD.source_notion_page_id
     OR NEW.mutation_kind IS DISTINCT FROM OLD.mutation_kind
     OR NEW.expected_active_attempt_id IS DISTINCT FROM OLD.expected_active_attempt_id
     OR NEW.expected_source_post_revision
       IS DISTINCT FROM OLD.expected_source_post_revision
     OR NEW.expected_status IS DISTINCT FROM OLD.expected_status
     OR NEW.expected_next_action IS DISTINCT FROM OLD.expected_next_action
     OR NEW.expected_publish_execution
       IS DISTINCT FROM OLD.expected_publish_execution
     OR NEW.desired_active_attempt_id IS DISTINCT FROM OLD.desired_active_attempt_id
     OR NEW.desired_status IS DISTINCT FROM OLD.desired_status
     OR NEW.desired_next_action IS DISTINCT FROM OLD.desired_next_action
     OR NEW.desired_publish_execution IS DISTINCT FROM OLD.desired_publish_execution
     OR NEW.desired_rednote_url IS DISTINCT FROM OLD.desired_rednote_url
     OR NEW.desired_rednote_note_id IS DISTINCT FROM OLD.desired_rednote_note_id
     OR NEW.desired_platform_publish_time
       IS DISTINCT FROM OLD.desired_platform_publish_time
     OR NEW.claim_worker_run_id IS DISTINCT FROM OLD.claim_worker_run_id
     OR NEW.claim_playwright_run_id IS DISTINCT FROM OLD.claim_playwright_run_id
     OR NEW.claim_occurred_at IS DISTINCT FROM OLD.claim_occurred_at
     OR NEW.claim_actor_id IS DISTINCT FROM OLD.claim_actor_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'rednote publish Posts mutation intent is immutable';
  END IF;

  IF OLD.state = 'applied' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'applied rednote publish Posts mutation cannot change';
  END IF;
  IF OLD.state = 'conflict' AND NEW.state NOT IN ('conflict', 'applied') THEN
    RAISE EXCEPTION 'conflicted rednote publish Posts mutation requires explicit resolution';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'rednote publish Posts mutation attempt count cannot decrease';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rednote_publish_attempt_requests_immutable
  ON rednote_publish_attempt_requests;
CREATE TRIGGER rednote_publish_attempt_requests_immutable
BEFORE UPDATE OR DELETE ON rednote_publish_attempt_requests
FOR EACH ROW EXECUTE FUNCTION prevent_rednote_publish_request_mutation();

DROP TRIGGER IF EXISTS rednote_publish_post_mutations_guard_update
  ON rednote_publish_post_mutations;
CREATE TRIGGER rednote_publish_post_mutations_guard_update
BEFORE UPDATE ON rednote_publish_post_mutations
FOR EACH ROW EXECUTE FUNCTION guard_rednote_publish_post_mutation_update();

DROP TRIGGER IF EXISTS rednote_publish_post_mutations_guard_delete
  ON rednote_publish_post_mutations;
CREATE TRIGGER rednote_publish_post_mutations_guard_delete
BEFORE DELETE ON rednote_publish_post_mutations
FOR EACH ROW EXECUTE FUNCTION prevent_rednote_publish_history_delete();

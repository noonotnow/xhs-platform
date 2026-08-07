CREATE TABLE IF NOT EXISTS rednote_publish_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_revision TEXT NOT NULL
    CHECK (contract_revision = 'rednote-publishing/v1'),
  source_notion_page_id TEXT NOT NULL
    CHECK (char_length(source_notion_page_id) > 0),
  source_local_publish_job_id UUID
    REFERENCES local_publish_jobs(id) ON DELETE RESTRICT,
  frozen_payload JSONB NOT NULL CHECK (jsonb_typeof(frozen_payload) = 'object'),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  payload_revision TEXT NOT NULL CHECK (char_length(payload_revision) BETWEEN 1 AND 128),
  executor_type TEXT NOT NULL CHECK (executor_type IN ('worker', 'operator')),
  executor_id TEXT NOT NULL CHECK (char_length(executor_id) > 0),
  worker_run_id TEXT,
  playwright_run_id TEXT,
  target_publish_at TIMESTAMP WITH TIME ZONE,
  requested_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  terminal_outcome TEXT
    CHECK (terminal_outcome IN ('accepted', 'known_failed', 'outcome_unknown')),
  terminal_at TIMESTAMP WITH TIME ZONE,
  receipt_lookup_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (receipt_lookup_state IN ('pending', 'found', 'not_found', 'not_required')),
  receipt_lookup_updated_at TIMESTAMP WITH TIME ZONE
    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  supersedes_attempt_id UUID
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  superseded_by_attempt_id UUID
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(diagnostics) = 'object'),
  CONSTRAINT rednote_publish_attempts_terminal_time_check CHECK (
    (terminal_outcome IS NULL AND terminal_at IS NULL)
    OR (terminal_outcome IS NOT NULL AND terminal_at IS NOT NULL)
  ),
  CONSTRAINT rednote_publish_attempts_worker_identity_check CHECK (
    (executor_type = 'worker' AND worker_run_id IS NOT NULL)
    OR (executor_type = 'operator' AND worker_run_id IS NULL)
  ),
  CONSTRAINT rednote_publish_attempts_active_check CHECK (
    NOT active
    OR (
      executor_type = 'worker'
      AND terminal_outcome IS DISTINCT FROM 'known_failed'
      AND receipt_lookup_state NOT IN ('found', 'not_required')
      AND superseded_by_attempt_id IS NULL
    )
  ),
  CONSTRAINT rednote_publish_attempts_known_failure_check CHECK (
    terminal_outcome IS DISTINCT FROM 'known_failed'
    OR (NOT active AND receipt_lookup_state = 'not_required')
  ),
  CONSTRAINT rednote_publish_attempts_supersession_check CHECK (
    (supersedes_attempt_id IS NULL OR supersedes_attempt_id <> id)
    AND (superseded_by_attempt_id IS NULL OR superseded_by_attempt_id <> id)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS rednote_publish_attempts_active_post_idx
  ON rednote_publish_attempts (source_notion_page_id)
  WHERE active;

CREATE INDEX IF NOT EXISTS rednote_publish_attempts_local_job_idx
  ON rednote_publish_attempts (source_local_publish_job_id)
  WHERE source_local_publish_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS rednote_publish_attempts_supersedes_idx
  ON rednote_publish_attempts (supersedes_attempt_id)
  WHERE supersedes_attempt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS rednote_publish_attempt_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'attempt_created', 'worker_claimed', 'worker_batched',
    'worker_batch_failed', 'execution_started', 'execution_evidence',
    'terminal_outcome_recorded', 'receipt_lookup', 'superseded'
  )),
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('worker', 'operator', 'create', 'plan', 'admin')),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) > 0),
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array'),
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(diagnostics) = 'object'),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS rednote_publish_attempt_single_execution_idx
  ON rednote_publish_attempt_events (attempt_id)
  WHERE event_type = 'execution_started';

CREATE INDEX IF NOT EXISTS rednote_publish_attempt_events_timeline_idx
  ON rednote_publish_attempt_events (attempt_id, occurred_at, created_at);

CREATE TABLE IF NOT EXISTS rednote_publish_attempt_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL UNIQUE
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  rednote_url TEXT NOT NULL CHECK (char_length(rednote_url) > 0),
  rednote_note_id TEXT NOT NULL CHECK (char_length(rednote_note_id) > 0),
  platform_publish_time TIMESTAMP WITH TIME ZONE NOT NULL,
  captured_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  provenance JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS rednote_publish_attempt_receipts_note_idx
  ON rednote_publish_attempt_receipts (rednote_note_id);

CREATE OR REPLACE FUNCTION guard_rednote_publish_attempt_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contract_revision IS DISTINCT FROM OLD.contract_revision
     OR NEW.source_notion_page_id IS DISTINCT FROM OLD.source_notion_page_id
     OR NEW.source_local_publish_job_id IS DISTINCT FROM OLD.source_local_publish_job_id
     OR NEW.frozen_payload IS DISTINCT FROM OLD.frozen_payload
     OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
     OR NEW.payload_revision IS DISTINCT FROM OLD.payload_revision
     OR NEW.executor_type IS DISTINCT FROM OLD.executor_type
     OR NEW.executor_id IS DISTINCT FROM OLD.executor_id
     OR NEW.worker_run_id IS DISTINCT FROM OLD.worker_run_id
     OR NEW.playwright_run_id IS DISTINCT FROM OLD.playwright_run_id
     OR NEW.target_publish_at IS DISTINCT FROM OLD.target_publish_at
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.supersedes_attempt_id IS DISTINCT FROM OLD.supersedes_attempt_id
     OR NEW.diagnostics IS DISTINCT FROM OLD.diagnostics THEN
    RAISE EXCEPTION 'rednote publish attempt immutable fields cannot be changed';
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
    RAISE EXCEPTION 'rednote publish attempt cannot be reactivated';
  END IF;

  IF OLD.superseded_by_attempt_id IS NOT NULL
     AND NEW.superseded_by_attempt_id IS DISTINCT FROM OLD.superseded_by_attempt_id THEN
    RAISE EXCEPTION 'rednote publish attempt supersession is immutable once set';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_rednote_publish_attempt_receipt_insert()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rednote_publish_attempts
    WHERE id = NEW.attempt_id
      AND terminal_outcome = 'accepted'
      AND receipt_lookup_state = 'found'
      AND NOT active
      AND superseded_by_attempt_id IS NULL
  ) THEN
    RAISE EXCEPTION 'receipt capture requires an accepted inactive attempt in found state';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_rednote_publish_history_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rednote publish attempt history cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_rednote_publish_append_only_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rednote publish attempt evidence and receipts are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rednote_publish_attempts_guard_update
  ON rednote_publish_attempts;
CREATE TRIGGER rednote_publish_attempts_guard_update
BEFORE UPDATE ON rednote_publish_attempts
FOR EACH ROW EXECUTE FUNCTION guard_rednote_publish_attempt_update();

DROP TRIGGER IF EXISTS rednote_publish_attempts_guard_delete
  ON rednote_publish_attempts;
CREATE TRIGGER rednote_publish_attempts_guard_delete
BEFORE DELETE ON rednote_publish_attempts
FOR EACH ROW EXECUTE FUNCTION prevent_rednote_publish_history_delete();

DROP TRIGGER IF EXISTS rednote_publish_attempt_events_immutable
  ON rednote_publish_attempt_events;
CREATE TRIGGER rednote_publish_attempt_events_immutable
BEFORE UPDATE OR DELETE ON rednote_publish_attempt_events
FOR EACH ROW EXECUTE FUNCTION prevent_rednote_publish_append_only_mutation();

DROP TRIGGER IF EXISTS rednote_publish_attempt_receipts_immutable
  ON rednote_publish_attempt_receipts;
CREATE TRIGGER rednote_publish_attempt_receipts_immutable
BEFORE UPDATE OR DELETE ON rednote_publish_attempt_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_rednote_publish_append_only_mutation();

DROP TRIGGER IF EXISTS rednote_publish_attempt_receipts_guard_insert
  ON rednote_publish_attempt_receipts;
CREATE TRIGGER rednote_publish_attempt_receipts_guard_insert
BEFORE INSERT ON rednote_publish_attempt_receipts
FOR EACH ROW EXECUTE FUNCTION guard_rednote_publish_attempt_receipt_insert();

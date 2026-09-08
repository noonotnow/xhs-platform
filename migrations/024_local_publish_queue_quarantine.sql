CREATE TABLE IF NOT EXISTS local_publish_queue_quarantines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key UUID NOT NULL UNIQUE,
  cutoff_at TIMESTAMPTZ NOT NULL,
  job_count INTEGER NOT NULL CHECK (job_count >= 0),
  active_claim_count INTEGER NOT NULL CHECK (active_claim_count >= 0),
  dispatch_evidence_count INTEGER NOT NULL CHECK (dispatch_evidence_count >= 0),
  prior_status_counts JSONB NOT NULL CHECK (jsonb_typeof(prior_status_counts) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS local_publish_queue_quarantine_items (
  quarantine_id UUID NOT NULL
    REFERENCES local_publish_queue_quarantines(id) ON DELETE RESTRICT,
  local_publish_job_id UUID NOT NULL
    REFERENCES local_publish_jobs(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL,
  prior_status TEXT NOT NULL,
  prior_claim_token UUID,
  prior_claimed_at TIMESTAMPTZ,
  prior_claim_expires_at TIMESTAMPTZ,
  prior_batch_item_state TEXT,
  had_dispatch_evidence BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (quarantine_id, local_publish_job_id)
);

CREATE INDEX IF NOT EXISTS local_publish_queue_quarantine_items_job_idx
  ON local_publish_queue_quarantine_items (local_publish_job_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_local_publish_queue_quarantine_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'local publish queue quarantine history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS local_publish_queue_quarantines_immutable
  ON local_publish_queue_quarantines;
CREATE TRIGGER local_publish_queue_quarantines_immutable
BEFORE UPDATE OR DELETE ON local_publish_queue_quarantines
FOR EACH ROW
WHEN (OLD.completed_at IS NOT NULL)
EXECUTE FUNCTION prevent_local_publish_queue_quarantine_mutation();

DROP TRIGGER IF EXISTS local_publish_queue_quarantines_no_truncate
  ON local_publish_queue_quarantines;
CREATE TRIGGER local_publish_queue_quarantines_no_truncate
BEFORE TRUNCATE ON local_publish_queue_quarantines
FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_publish_queue_quarantine_mutation();

DROP TRIGGER IF EXISTS local_publish_queue_quarantine_items_immutable
  ON local_publish_queue_quarantine_items;
CREATE TRIGGER local_publish_queue_quarantine_items_immutable
BEFORE UPDATE OR DELETE ON local_publish_queue_quarantine_items
FOR EACH ROW EXECUTE FUNCTION prevent_local_publish_queue_quarantine_mutation();

DROP TRIGGER IF EXISTS local_publish_queue_quarantine_items_no_truncate
  ON local_publish_queue_quarantine_items;
CREATE TRIGGER local_publish_queue_quarantine_items_no_truncate
BEFORE TRUNCATE ON local_publish_queue_quarantine_items
FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_publish_queue_quarantine_mutation();

ALTER TABLE rednote_publish_attempt_events
  DROP CONSTRAINT IF EXISTS rednote_publish_attempt_events_event_type_check;
ALTER TABLE rednote_publish_attempt_events
  ADD CONSTRAINT rednote_publish_attempt_events_event_type_check
    CHECK (event_type IN (
      'attempt_created', 'worker_claimed', 'worker_batched',
      'worker_batch_failed', 'execution_started', 'execution_evidence',
      'terminal_outcome_recorded', 'receipt_lookup', 'superseded',
      'queue_quarantined'
    ));

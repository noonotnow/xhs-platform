CREATE TABLE IF NOT EXISTS rednote_publish_job_recoveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_publish_job_id UUID NOT NULL UNIQUE
    REFERENCES local_publish_jobs(id) ON DELETE RESTRICT,
  batch_item_id UUID NOT NULL UNIQUE
    REFERENCES rednote_publish_batch_items(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL
    REFERENCES rednote_publish_batches(id) ON DELETE RESTRICT,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  item_hash TEXT NOT NULL CHECK (item_hash ~ '^[a-f0-9]{64}$'),
  snapshot_revision TEXT NOT NULL CHECK (char_length(snapshot_revision) BETWEEN 1 AND 64),
  prior_error_code TEXT NOT NULL
    CHECK (prior_error_code = 'BOUNDED_BATCH_BYPASS_DISABLED'),
  prior_error_message TEXT
    CHECK (prior_error_message IS NULL OR char_length(prior_error_message) <= 500),
  prior_claim_attempts INTEGER NOT NULL CHECK (prior_claim_attempts >= 0),
  prior_claimed_at TIMESTAMP WITH TIME ZONE,
  prior_completed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  recovered_by TEXT NOT NULL CHECK (char_length(recovered_by) BETWEEN 1 AND 320),
  recovered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS rednote_publish_job_recoveries_batch_idx
  ON rednote_publish_job_recoveries (batch_id, recovered_at);

CREATE OR REPLACE FUNCTION prevent_rednote_publish_job_recovery_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'rednote_publish_job_recoveries is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rednote_publish_job_recoveries_append_only
  ON rednote_publish_job_recoveries;
CREATE TRIGGER rednote_publish_job_recoveries_append_only
BEFORE UPDATE OR DELETE ON rednote_publish_job_recoveries
FOR EACH ROW EXECUTE FUNCTION prevent_rednote_publish_job_recovery_mutation();

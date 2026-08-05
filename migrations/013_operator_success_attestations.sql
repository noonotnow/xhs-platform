CREATE TABLE IF NOT EXISTS local_publish_job_success_attestations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key UUID NOT NULL UNIQUE,
  local_publish_job_id UUID NOT NULL UNIQUE
    REFERENCES local_publish_jobs(id) ON DELETE RESTRICT,
  notion_page_id TEXT NOT NULL,
  batch_id UUID NOT NULL
    REFERENCES rednote_publish_batches(id) ON DELETE RESTRICT,
  batch_item_id UUID NOT NULL UNIQUE
    REFERENCES rednote_publish_batch_items(id) ON DELETE RESTRICT,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  item_hash TEXT NOT NULL CHECK (item_hash ~ '^[a-f0-9]{64}$'),
  snapshot_revision TEXT NOT NULL CHECK (char_length(snapshot_revision) BETWEEN 1 AND 64),
  snapshot_digest TEXT NOT NULL
    CHECK (snapshot_digest ~ '^[a-f0-9]{64}$' AND snapshot_digest = item_hash),
  contract_revision TEXT NOT NULL
    CHECK (contract_revision = 'operator-success-attestation/v1'),
  prior_claim_token_digest TEXT NOT NULL
    CHECK (prior_claim_token_digest ~ '^[a-f0-9]{64}$'),
  expected_outcome TEXT NOT NULL CHECK (char_length(expected_outcome) BETWEEN 1 AND 300),
  requested_publish_at TIMESTAMP WITH TIME ZONE NOT NULL,
  prior_job_status TEXT NOT NULL,
  prior_error_code TEXT,
  prior_error_message TEXT,
  prior_claim_attempts INTEGER NOT NULL CHECK (prior_claim_attempts >= 0),
  prior_staged_at TIMESTAMP WITH TIME ZONE,
  prior_dispatch_authorized_at TIMESTAMP WITH TIME ZONE,
  prior_completed_at TIMESTAMP WITH TIME ZONE,
  attested_by TEXT NOT NULL CHECK (char_length(attested_by) BETWEEN 3 AND 320),
  attested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS local_publish_job_success_attestation_release_acks (
  success_attestation_id UUID PRIMARY KEY
    REFERENCES local_publish_job_success_attestations(id) ON DELETE RESTRICT,
  acknowledgement_claim_token_digest TEXT NOT NULL
    CHECK (acknowledgement_claim_token_digest ~ '^[a-f0-9]{64}$'),
  acknowledged_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION prevent_local_publish_job_success_attestation_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'local publish job success attestations are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS local_publish_job_success_attestations_immutable
  ON local_publish_job_success_attestations;
CREATE TRIGGER local_publish_job_success_attestations_immutable
BEFORE UPDATE OR DELETE ON local_publish_job_success_attestations
FOR EACH ROW EXECUTE FUNCTION prevent_local_publish_job_success_attestation_mutation();

DROP TRIGGER IF EXISTS local_publish_job_success_attestation_release_acks_immutable
  ON local_publish_job_success_attestation_release_acks;
CREATE TRIGGER local_publish_job_success_attestation_release_acks_immutable
BEFORE UPDATE OR DELETE ON local_publish_job_success_attestation_release_acks
FOR EACH ROW EXECUTE FUNCTION prevent_local_publish_job_success_attestation_mutation();

ALTER TABLE local_publish_jobs
  ADD COLUMN IF NOT EXISTS success_attestation_id UUID
    REFERENCES local_publish_job_success_attestations(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS local_publish_jobs_success_attestation_idx
  ON local_publish_jobs (success_attestation_id)
  WHERE success_attestation_id IS NOT NULL;

ALTER TABLE local_publish_jobs
  DROP CONSTRAINT IF EXISTS local_publish_jobs_status_check;
ALTER TABLE local_publish_jobs
  ADD CONSTRAINT local_publish_jobs_status_check
    CHECK (status IN (
      'queued', 'claimed', 'staged', 'submitted', 'scheduled',
      'operator_attested', 'verification_pending', 'verified', 'reconciled', 'failed'
    ));

ALTER TABLE rednote_publish_batch_items
  DROP CONSTRAINT IF EXISTS rednote_publish_batch_items_state_check;
ALTER TABLE rednote_publish_batch_items
  ADD CONSTRAINT rednote_publish_batch_items_state_check
    CHECK (state IN (
      'needs_approval', 'approved', 'invalidated', 'queued', 'claimed', 'staged',
      'submitted', 'scheduled', 'operator_attested', 'verification_pending',
      'verified', 'reconciled', 'failed'
    ));

DROP INDEX IF EXISTS local_publish_jobs_verification_due_idx;
CREATE INDEX local_publish_jobs_verification_due_idx
  ON local_publish_jobs (next_verification_at, created_at)
  WHERE status IN (
    'submitted', 'scheduled', 'operator_attested', 'verification_pending'
  );

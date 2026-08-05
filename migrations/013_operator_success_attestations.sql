ALTER TABLE local_publish_jobs
  DROP CONSTRAINT IF EXISTS local_publish_jobs_status_check;

ALTER TABLE local_publish_jobs
  ADD CONSTRAINT local_publish_jobs_status_check
    CHECK (status IN (
      'queued', 'claimed', 'staged', 'submitted', 'scheduled',
      'verification_pending', 'verified', 'reconciled', 'failed',
      'operator_attested'
    ));

ALTER TABLE rednote_publish_batch_items
  DROP CONSTRAINT IF EXISTS rednote_publish_batch_items_state_check;

ALTER TABLE rednote_publish_batch_items
  ADD CONSTRAINT rednote_publish_batch_items_state_check
    CHECK (state IN (
      'needs_approval', 'approved', 'invalidated', 'queued', 'claimed', 'staged',
      'submitted', 'scheduled', 'verification_pending', 'verified', 'reconciled',
      'failed', 'operator_attested'
    ));

CREATE TABLE IF NOT EXISTS local_publish_worker_capabilities (
  capability TEXT PRIMARY KEY,
  last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS local_publish_operator_success_attestations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  revision TEXT NOT NULL,
  local_publish_job_id UUID NOT NULL UNIQUE
    REFERENCES local_publish_jobs(id) ON DELETE RESTRICT,
  notion_page_id TEXT NOT NULL,
  batch_id UUID NOT NULL REFERENCES rednote_publish_batches(id) ON DELETE RESTRICT,
  batch_item_id UUID NOT NULL UNIQUE
    REFERENCES rednote_publish_batch_items(id) ON DELETE RESTRICT,
  snapshot_digest TEXT NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  item_hash TEXT NOT NULL CHECK (item_hash ~ '^[a-f0-9]{64}$'),
  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
  claim_token_digest TEXT NOT NULL CHECK (claim_token_digest ~ '^[a-f0-9]{64}$'),
  attested_by TEXT NOT NULL CHECK (char_length(attested_by) <= 320),
  receipt_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (receipt_status IN ('pending', 'verified')),
  receipt_code TEXT CHECK (receipt_code IS NULL OR char_length(receipt_code) <= 80),
  receipt_message TEXT CHECK (receipt_message IS NULL OR char_length(receipt_message) <= 500),
  receipt_note_id TEXT CHECK (receipt_note_id IS NULL OR char_length(receipt_note_id) <= 128),
  receipt_share_url TEXT CHECK (receipt_share_url IS NULL OR char_length(receipt_share_url) <= 500),
  attested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  receipt_updated_at TIMESTAMP WITH TIME ZONE
);

CREATE OR REPLACE FUNCTION prevent_operator_success_attestation_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.revision <> NEW.revision
     OR OLD.local_publish_job_id <> NEW.local_publish_job_id
     OR OLD.notion_page_id <> NEW.notion_page_id
     OR OLD.batch_id <> NEW.batch_id
     OR OLD.batch_item_id <> NEW.batch_item_id
     OR OLD.snapshot_digest <> NEW.snapshot_digest
     OR OLD.item_hash <> NEW.item_hash
     OR OLD.scheduled_at <> NEW.scheduled_at
     OR OLD.claim_token_digest <> NEW.claim_token_digest
     OR OLD.attested_by <> NEW.attested_by
     OR OLD.attested_at <> NEW.attested_at THEN
    RAISE EXCEPTION 'operator success attestation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operator_success_attestation_immutable
  ON local_publish_operator_success_attestations;
CREATE TRIGGER operator_success_attestation_immutable
BEFORE UPDATE ON local_publish_operator_success_attestations
FOR EACH ROW EXECUTE FUNCTION prevent_operator_success_attestation_mutation();

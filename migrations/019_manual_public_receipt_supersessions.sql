CREATE TABLE IF NOT EXISTS manual_public_receipt_supersessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key UUID NOT NULL UNIQUE,
  manual_handling_id UUID NOT NULL UNIQUE
    REFERENCES plan_operator_scheduled_posts(id) ON DELETE RESTRICT,
  manual_reconciliation_id UUID NOT NULL UNIQUE
    REFERENCES manual_reconciliation_requests(id) ON DELETE RESTRICT,
  local_publish_job_id UUID NOT NULL UNIQUE
    REFERENCES local_publish_jobs(id) ON DELETE RESTRICT,
  notion_page_id TEXT NOT NULL UNIQUE,
  batch_id UUID NOT NULL
    REFERENCES rednote_publish_batches(id) ON DELETE RESTRICT,
  batch_item_id UUID NOT NULL UNIQUE
    REFERENCES rednote_publish_batch_items(id) ON DELETE RESTRICT,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  item_hash TEXT NOT NULL CHECK (item_hash ~ '^[a-f0-9]{64}$'),
  snapshot_revision TEXT NOT NULL
    CHECK (char_length(snapshot_revision) BETWEEN 1 AND 64),
  canonical_notion_revision TEXT NOT NULL
    CHECK (char_length(canonical_notion_revision) BETWEEN 1 AND 64),
  requested_note_id TEXT NOT NULL CHECK (char_length(requested_note_id) <= 128),
  requested_share_url TEXT NOT NULL CHECK (char_length(requested_share_url) <= 500),
  provenance TEXT NOT NULL CHECK (provenance = 'manual'),
  prior_job_status TEXT NOT NULL,
  prior_error_code TEXT,
  prior_error_message TEXT,
  prior_claim_attempts INTEGER NOT NULL CHECK (prior_claim_attempts >= 0),
  prior_claim_expires_at TIMESTAMP WITH TIME ZONE,
  prior_staged_at TIMESTAMP WITH TIME ZONE NOT NULL,
  prior_dispatch_authorized_at TIMESTAMP WITH TIME ZONE NOT NULL,
  superseded_by TEXT NOT NULL CHECK (char_length(superseded_by) BETWEEN 3 AND 320),
  superseded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION prevent_manual_public_receipt_supersession_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manual public receipt supersessions are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS manual_public_receipt_supersessions_immutable
  ON manual_public_receipt_supersessions;
CREATE TRIGGER manual_public_receipt_supersessions_immutable
BEFORE UPDATE OR DELETE ON manual_public_receipt_supersessions
FOR EACH ROW EXECUTE FUNCTION prevent_manual_public_receipt_supersession_mutation();

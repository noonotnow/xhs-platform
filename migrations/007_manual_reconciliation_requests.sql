ALTER TABLE external_post_reconciliations
  DROP CONSTRAINT IF EXISTS external_post_reconciliations_outcome_check;

ALTER TABLE external_post_reconciliations
  ADD CONSTRAINT external_post_reconciliations_outcome_check
    CHECK (
      outcome IS NULL OR outcome IN (
        'matched_note_id',
        'matched_url',
        'created',
        'targeted_page'
      )
    );

CREATE TABLE IF NOT EXISTS manual_reconciliation_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notion_page_id TEXT NOT NULL,
  source_local_job_id UUID REFERENCES local_publish_jobs(id),
  requested_note_id TEXT NOT NULL CHECK (char_length(requested_note_id) <= 128),
  requested_share_url TEXT NOT NULL CHECK (char_length(requested_share_url) <= 500),
  expected_snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'verifying', 'reconciled', 'failed')),
  idempotency_key UUID NOT NULL UNIQUE,
  claim_token UUID,
  claim_attempts INTEGER NOT NULL DEFAULT 0 CHECK (claim_attempts >= 0),
  claimed_at TIMESTAMP WITH TIME ZONE,
  claim_expires_at TIMESTAMP WITH TIME ZONE,
  verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0),
  next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  external_reconciliation_id UUID UNIQUE REFERENCES external_post_reconciliations(id),
  error_code TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE,
  UNIQUE (notion_page_id, requested_note_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS manual_reconciliation_requests_active_page_idx
  ON manual_reconciliation_requests (notion_page_id)
  WHERE status IN ('queued', 'verifying');

CREATE INDEX IF NOT EXISTS manual_reconciliation_requests_due_idx
  ON manual_reconciliation_requests (next_attempt_at, claim_expires_at, created_at)
  WHERE status IN ('queued', 'verifying');

CREATE INDEX IF NOT EXISTS manual_reconciliation_requests_page_created_idx
  ON manual_reconciliation_requests (notion_page_id, created_at DESC);

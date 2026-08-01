CREATE TABLE IF NOT EXISTS local_publish_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notion_page_id TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'ambiguous', 'succeeded', 'failed')),
  idempotency_key UUID NOT NULL UNIQUE,
  claim_token UUID,
  claim_attempts INTEGER NOT NULL DEFAULT 0 CHECK (claim_attempts >= 0),
  claimed_at TIMESTAMP WITH TIME ZONE,
  claim_expires_at TIMESTAMP WITH TIME ZONE,
  error_code TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  note_id TEXT CHECK (note_id IS NULL OR char_length(note_id) <= 128),
  share_url TEXT CHECK (share_url IS NULL OR char_length(share_url) <= 500),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX IF NOT EXISTS local_publish_jobs_active_page_idx
  ON local_publish_jobs (notion_page_id)
  WHERE status IN ('queued', 'claimed', 'ambiguous');

CREATE INDEX IF NOT EXISTS local_publish_jobs_claim_idx
  ON local_publish_jobs (status, claim_expires_at, created_at);

CREATE INDEX IF NOT EXISTS local_publish_jobs_page_created_idx
  ON local_publish_jobs (notion_page_id, created_at DESC);

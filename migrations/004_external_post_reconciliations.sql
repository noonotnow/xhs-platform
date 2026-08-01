CREATE TABLE IF NOT EXISTS external_post_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id TEXT NOT NULL UNIQUE CHECK (char_length(note_id) <= 128),
  share_url TEXT NOT NULL UNIQUE CHECK (char_length(share_url) <= 500),
  snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'succeeded', 'failed')),
  idempotency_key UUID NOT NULL UNIQUE,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('matched_note_id', 'matched_url', 'created')),
  notion_page_id TEXT,
  error_code TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS external_post_reconciliations_status_idx
  ON external_post_reconciliations (status, updated_at);

CREATE INDEX IF NOT EXISTS external_post_reconciliations_created_idx
  ON external_post_reconciliations (created_at DESC);

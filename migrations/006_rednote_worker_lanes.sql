CREATE TABLE IF NOT EXISTS rednote_metric_collection_state (
  notion_page_id TEXT PRIMARY KEY,
  source_job_id UUID NOT NULL REFERENCES local_publish_jobs(id) ON DELETE CASCADE,
  latest_metrics JSONB,
  last_observed_at TIMESTAMP WITH TIME ZONE,
  last_snapshot_at TIMESTAMP WITH TIME ZONE,
  next_due_at TIMESTAMP WITH TIME ZONE,
  claim_token UUID,
  claimed_at TIMESTAMP WITH TIME ZONE,
  claim_expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS rednote_metric_collection_due_idx
  ON rednote_metric_collection_state (next_due_at, claim_expires_at)
  WHERE next_due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS post_performance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notion_page_id TEXT NOT NULL,
  source_job_id UUID NOT NULL REFERENCES local_publish_jobs(id) ON DELETE CASCADE,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  metrics JSONB NOT NULL,
  write_reason TEXT NOT NULL CHECK (write_reason IN ('changed', 'checkpoint')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (notion_page_id, observed_at)
);

CREATE INDEX IF NOT EXISTS post_performance_snapshots_post_idx
  ON post_performance_snapshots (notion_page_id, observed_at DESC);

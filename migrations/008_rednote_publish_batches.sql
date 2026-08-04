CREATE TABLE IF NOT EXISTS rednote_publish_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('weekly', 'catch_up', 'bootstrap')),
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'approved', 'partially_approved')),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  window_start TIMESTAMP WITH TIME ZONE,
  window_end TIMESTAMP WITH TIME ZONE,
  approved_at TIMESTAMP WITH TIME ZONE,
  approved_by TEXT CHECK (approved_by IS NULL OR char_length(approved_by) <= 320),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rednote_publish_batch_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES rednote_publish_batches(id) ON DELETE CASCADE,
  notion_page_id TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  item_hash TEXT NOT NULL CHECK (item_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'needs_approval'
    CHECK (state IN (
      'needs_approval', 'approved', 'invalidated', 'queued', 'claimed', 'staged',
      'submitted', 'scheduled', 'verification_pending', 'verified', 'reconciled', 'failed'
    )),
  dispatch_mode TEXT NOT NULL CHECK (dispatch_mode IN ('scheduled', 'post_now')),
  late_by_seconds INTEGER NOT NULL DEFAULT 0 CHECK (late_by_seconds >= 0),
  invalidation_reason TEXT CHECK (
    invalidation_reason IS NULL OR char_length(invalidation_reason) <= 500
  ),
  local_publish_job_id UUID UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (batch_id, notion_page_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS rednote_publish_batch_items_active_page_idx
  ON rednote_publish_batch_items (notion_page_id)
  WHERE state NOT IN ('invalidated', 'reconciled', 'failed');

ALTER TABLE local_publish_jobs
  ADD COLUMN IF NOT EXISTS batch_item_id UUID
    REFERENCES rednote_publish_batch_items(id) ON DELETE RESTRICT;

ALTER TABLE local_publish_jobs
  ADD COLUMN IF NOT EXISTS dispatch_authorized_at TIMESTAMP WITH TIME ZONE;

CREATE UNIQUE INDEX IF NOT EXISTS local_publish_jobs_batch_item_idx
  ON local_publish_jobs (batch_item_id)
  WHERE batch_item_id IS NOT NULL;

ALTER TABLE rednote_publish_batch_items
  DROP CONSTRAINT IF EXISTS rednote_publish_batch_items_local_publish_job_id_fkey;

ALTER TABLE rednote_publish_batch_items
  ADD CONSTRAINT rednote_publish_batch_items_local_publish_job_id_fkey
  FOREIGN KEY (local_publish_job_id) REFERENCES local_publish_jobs(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS rednote_sweep_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  local_date DATE NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE,
  batch_id UUID REFERENCES rednote_publish_batches(id) ON DELETE SET NULL,
  UNIQUE (cadence, local_date)
);

CREATE OR REPLACE FUNCTION sync_rednote_batch_item_state()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.batch_item_id IS NOT NULL THEN
    UPDATE rednote_publish_batch_items
    SET state = NEW.status,
        local_publish_job_id = NEW.id,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.batch_item_id
      AND state <> 'invalidated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS local_publish_job_batch_state ON local_publish_jobs;
CREATE TRIGGER local_publish_job_batch_state
AFTER INSERT OR UPDATE OF status ON local_publish_jobs
FOR EACH ROW EXECUTE FUNCTION sync_rednote_batch_item_state();

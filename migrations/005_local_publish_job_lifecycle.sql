ALTER TABLE local_publish_jobs
  DROP CONSTRAINT IF EXISTS local_publish_jobs_status_check;

UPDATE local_publish_jobs
SET status = CASE status
  WHEN 'ambiguous' THEN 'verified'
  WHEN 'succeeded' THEN 'reconciled'
  ELSE status
END;

ALTER TABLE local_publish_jobs
  ADD COLUMN IF NOT EXISTS verification_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (verification_attempts >= 0),
  ADD COLUMN IF NOT EXISTS next_verification_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS staged_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMP WITH TIME ZONE,
  ADD CONSTRAINT local_publish_jobs_status_check
    CHECK (status IN (
      'queued',
      'claimed',
      'staged',
      'submitted',
      'scheduled',
      'verification_pending',
      'verified',
      'reconciled',
      'failed'
    ));

UPDATE local_publish_jobs
SET verified_at = COALESCE(verified_at, updated_at)
WHERE status IN ('verified', 'reconciled');

UPDATE local_publish_jobs
SET reconciled_at = COALESCE(reconciled_at, completed_at, updated_at)
WHERE status = 'reconciled';

DROP INDEX IF EXISTS local_publish_jobs_active_page_idx;

CREATE UNIQUE INDEX local_publish_jobs_active_page_idx
  ON local_publish_jobs (notion_page_id)
  WHERE status NOT IN ('reconciled', 'failed');

CREATE INDEX IF NOT EXISTS local_publish_jobs_verification_due_idx
  ON local_publish_jobs (next_verification_at, created_at)
  WHERE status IN ('submitted', 'scheduled', 'verification_pending');

CREATE INDEX IF NOT EXISTS local_publish_jobs_reconciliation_due_idx
  ON local_publish_jobs (claim_expires_at, created_at)
  WHERE status = 'verified';

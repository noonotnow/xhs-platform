-- Existing singleton records are retained in the explicitly named legacy
-- workspace; new callers must always select an owned workspace.
ALTER TABLE local_publish_jobs
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'legacy-local-publish'
  CHECK (char_length(workspace_id) BETWEEN 1 AND 128);

CREATE UNIQUE INDEX IF NOT EXISTS local_publish_jobs_workspace_id_idx
  ON local_publish_jobs (workspace_id, id);

ALTER TABLE local_publish_jobs
  DROP CONSTRAINT IF EXISTS local_publish_jobs_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS local_publish_jobs_workspace_idempotency_idx
  ON local_publish_jobs (workspace_id, idempotency_key);
DROP INDEX IF EXISTS local_publish_jobs_idempotency_key_key;
DROP INDEX IF EXISTS local_publish_jobs_notion_page_id_active_idx;
DROP INDEX IF EXISTS local_publish_jobs_active_post_idx;
DROP INDEX IF EXISTS local_publish_jobs_active_notion_page_idx;
CREATE UNIQUE INDEX IF NOT EXISTS local_publish_jobs_active_workspace_post_idx
  ON local_publish_jobs (workspace_id, notion_page_id)
  WHERE status NOT IN ('reconciled', 'succeeded', 'failed');
CREATE INDEX IF NOT EXISTS local_publish_jobs_workspace_claim_idx
  ON local_publish_jobs (workspace_id, status, next_verification_at, created_at);

ALTER TABLE rednote_publish_attempts
  DROP CONSTRAINT IF EXISTS rednote_publish_attempts_local_job_workspace_fk;
ALTER TABLE rednote_publish_attempts
  ADD CONSTRAINT rednote_publish_attempts_local_job_workspace_fk
  FOREIGN KEY (workspace_id, source_local_publish_job_id)
  REFERENCES local_publish_jobs (workspace_id, id)
  ON DELETE RESTRICT;

ALTER TABLE manual_reconciliation_requests
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'legacy-local-publish'
  CHECK (char_length(workspace_id) BETWEEN 1 AND 128);
ALTER TABLE manual_reconciliation_requests
  ADD COLUMN IF NOT EXISTS verified_snapshot JSONB
  CHECK (verified_snapshot IS NULL OR jsonb_typeof(verified_snapshot) = 'object');
ALTER TABLE manual_reconciliation_requests
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE manual_reconciliation_requests
  DROP CONSTRAINT IF EXISTS manual_reconciliation_requests_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS manual_reconciliation_workspace_idempotency_idx
  ON manual_reconciliation_requests (workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS manual_reconciliation_workspace_state_idx
  ON manual_reconciliation_requests (workspace_id, status, next_attempt_at);

ALTER TABLE plan_operator_scheduled_posts
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'legacy-local-publish'
  CHECK (char_length(workspace_id) BETWEEN 1 AND 128);
ALTER TABLE plan_operator_scheduled_posts
  DROP CONSTRAINT IF EXISTS plan_operator_scheduled_posts_notion_page_id_key;
DROP INDEX IF EXISTS plan_operator_scheduled_posts_notion_page_id_key;
DROP INDEX IF EXISTS plan_operator_scheduled_posts_notion_page_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS plan_operator_scheduled_workspace_page_idx
  ON plan_operator_scheduled_posts (workspace_id, notion_page_id);

ALTER TABLE external_post_reconciliations
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'legacy-local-publish'
  CHECK (char_length(workspace_id) BETWEEN 1 AND 128);
CREATE UNIQUE INDEX IF NOT EXISTS external_post_reconciliation_workspace_id_idx
  ON external_post_reconciliations (workspace_id, id);

ALTER TABLE xhs_publish_receipts
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'legacy-local-publish'
  CHECK (char_length(workspace_id) BETWEEN 1 AND 128);
ALTER TABLE xhs_publish_receipts
  DROP CONSTRAINT IF EXISTS xhs_publish_receipts_notion_page_id_key;
DROP INDEX IF EXISTS xhs_publish_receipts_notion_page_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS xhs_publish_receipts_workspace_page_idx
  ON xhs_publish_receipts (workspace_id, notion_page_id);
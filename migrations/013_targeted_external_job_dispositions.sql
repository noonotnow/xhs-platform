ALTER TABLE manual_reconciliation_requests
  ADD COLUMN IF NOT EXISTS request_kind TEXT NOT NULL DEFAULT 'notion_only'
    CHECK (request_kind IN ('notion_only', 'targeted_local_job'));

CREATE UNIQUE INDEX IF NOT EXISTS manual_reconciliation_requests_target_job_idx
  ON manual_reconciliation_requests (source_local_job_id)
  WHERE request_kind = 'targeted_local_job';

CREATE UNIQUE INDEX IF NOT EXISTS manual_reconciliation_requests_target_note_idx
  ON manual_reconciliation_requests (requested_note_id)
  WHERE request_kind = 'targeted_local_job';

CREATE UNIQUE INDEX IF NOT EXISTS manual_reconciliation_requests_target_share_url_idx
  ON manual_reconciliation_requests (requested_share_url)
  WHERE request_kind = 'targeted_local_job';

ALTER TABLE manual_reconciliation_requests
  DROP CONSTRAINT IF EXISTS manual_reconciliation_requests_external_reconciliation_id_key;

CREATE INDEX IF NOT EXISTS manual_reconciliation_requests_external_reconciliation_idx
  ON manual_reconciliation_requests (external_reconciliation_id)
  WHERE external_reconciliation_id IS NOT NULL;

ALTER TABLE local_publish_jobs
  ADD COLUMN IF NOT EXISTS external_disposition_request_id UUID
    REFERENCES manual_reconciliation_requests(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS local_publish_jobs_external_disposition_idx
  ON local_publish_jobs (external_disposition_request_id)
  WHERE external_disposition_request_id IS NOT NULL;

ALTER TABLE plan_operator_scheduled_posts
  ALTER COLUMN scheduled_at DROP NOT NULL;

ALTER TABLE plan_operator_scheduled_posts
  ADD COLUMN IF NOT EXISTS handling_mode TEXT NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS receipt_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS manual_reconciliation_id UUID
    REFERENCES manual_reconciliation_requests(id),
  ADD COLUMN IF NOT EXISTS note_id TEXT,
  ADD COLUMN IF NOT EXISTS share_url TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE
    NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE plan_operator_scheduled_posts
  DROP CONSTRAINT IF EXISTS plan_operator_scheduled_posts_recorded_by_check;

ALTER TABLE plan_operator_scheduled_posts
  ADD CONSTRAINT plan_operator_scheduled_posts_recorded_by_check
    CHECK (recorded_by IN ('plan', 'admin'));

ALTER TABLE plan_operator_scheduled_posts
  DROP CONSTRAINT IF EXISTS plan_operator_scheduled_posts_handling_mode_check;

ALTER TABLE plan_operator_scheduled_posts
  ADD CONSTRAINT plan_operator_scheduled_posts_handling_mode_check
    CHECK (handling_mode IN ('scheduled', 'published'));

ALTER TABLE plan_operator_scheduled_posts
  DROP CONSTRAINT IF EXISTS plan_operator_scheduled_posts_receipt_status_check;

ALTER TABLE plan_operator_scheduled_posts
  ADD CONSTRAINT plan_operator_scheduled_posts_receipt_status_check
    CHECK (receipt_status IN ('pending', 'reconciled'));

ALTER TABLE plan_operator_scheduled_posts
  DROP CONSTRAINT IF EXISTS plan_operator_scheduled_posts_receipt_identity_check;

WITH latest_reconciliation AS (
  SELECT DISTINCT ON (notion_page_id)
    id,
    notion_page_id,
    requested_note_id,
    requested_share_url,
    external_reconciliation_id,
    completed_at,
    created_at
  FROM manual_reconciliation_requests
  WHERE status = 'reconciled'
  ORDER BY notion_page_id, completed_at DESC NULLS LAST, created_at DESC
)
UPDATE plan_operator_scheduled_posts AS handling
SET receipt_status = 'reconciled',
    manual_reconciliation_id = request.id,
    note_id = request.requested_note_id,
    share_url = request.requested_share_url,
    published_at = COALESCE(
      external.completed_at,
      request.completed_at,
      handling.reconciled_at
    )
FROM latest_reconciliation AS request
LEFT JOIN external_post_reconciliations AS external
  ON external.id = request.external_reconciliation_id
WHERE handling.reconciled_at IS NOT NULL
  AND request.notion_page_id = handling.notion_page_id;

-- Legacy rows could be marked reconciled without an exact durable receipt.
-- Keep those rows pending and non-dispatchable until public identity is verified.
UPDATE plan_operator_scheduled_posts
SET receipt_status = 'pending',
    reconciled_at = NULL,
    manual_reconciliation_id = NULL,
    note_id = NULL,
    share_url = NULL,
    published_at = NULL
WHERE reconciled_at IS NOT NULL
  AND (
    manual_reconciliation_id IS NULL
    OR note_id IS NULL
    OR share_url IS NULL
    OR published_at IS NULL
  );

ALTER TABLE plan_operator_scheduled_posts
  ADD CONSTRAINT plan_operator_scheduled_posts_receipt_identity_check
    CHECK (
      (
        receipt_status = 'pending'
        AND reconciled_at IS NULL
        AND manual_reconciliation_id IS NULL
        AND note_id IS NULL
        AND share_url IS NULL
        AND published_at IS NULL
      )
      OR (
        receipt_status = 'reconciled'
        AND reconciled_at IS NOT NULL
        AND manual_reconciliation_id IS NOT NULL
        AND note_id IS NOT NULL
        AND share_url IS NOT NULL
        AND published_at IS NOT NULL
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS
  plan_operator_scheduled_posts_manual_reconciliation_idx
  ON plan_operator_scheduled_posts (manual_reconciliation_id)
  WHERE manual_reconciliation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_operator_scheduled_local_dispatch()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status <> 'failed'
     AND EXISTS (
       SELECT 1
       FROM plan_operator_scheduled_posts
       WHERE notion_page_id = NEW.notion_page_id
     ) THEN
    RAISE EXCEPTION 'manually handled post % is not dispatchable', NEW.notion_page_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_operator_scheduled_batch_dispatch()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state NOT IN ('invalidated', 'failed')
     AND EXISTS (
       SELECT 1
       FROM plan_operator_scheduled_posts
       WHERE notion_page_id = NEW.notion_page_id
     ) THEN
    RAISE EXCEPTION 'manually handled post % cannot enter a publish batch', NEW.notion_page_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE external_post_reconciliations
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'automation',
  ADD COLUMN IF NOT EXISTS manual_handling_id UUID
    REFERENCES plan_operator_scheduled_posts(id);

ALTER TABLE external_post_reconciliations
  DROP CONSTRAINT IF EXISTS external_post_reconciliations_source_check;

ALTER TABLE external_post_reconciliations
  ADD CONSTRAINT external_post_reconciliations_source_check
    CHECK (source IN ('automation', 'manual', 'recovery'));

ALTER TABLE xhs_publish_receipts
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'automation',
  ADD COLUMN IF NOT EXISTS manual_handling_id UUID
    REFERENCES plan_operator_scheduled_posts(id);

ALTER TABLE xhs_publish_receipts
  DROP CONSTRAINT IF EXISTS xhs_publish_receipts_source_check;

ALTER TABLE xhs_publish_receipts
  ADD CONSTRAINT xhs_publish_receipts_source_check
    CHECK (source IN ('automation', 'manual', 'recovery'));

CREATE INDEX IF NOT EXISTS xhs_publish_receipts_manual_source_idx
  ON xhs_publish_receipts (manual_handling_id)
  WHERE source = 'manual';

ALTER TABLE rednote_metric_collection_state
  ALTER COLUMN source_job_id DROP NOT NULL;

ALTER TABLE rednote_metric_collection_state
  ADD COLUMN IF NOT EXISTS manual_handling_id UUID
    REFERENCES plan_operator_scheduled_posts(id);

ALTER TABLE rednote_metric_collection_state
  DROP CONSTRAINT IF EXISTS rednote_metric_collection_state_source_check;

ALTER TABLE rednote_metric_collection_state
  ADD CONSTRAINT rednote_metric_collection_state_source_check
    CHECK (
      (source_job_id IS NOT NULL AND manual_handling_id IS NULL)
      OR (source_job_id IS NULL AND manual_handling_id IS NOT NULL)
    );

ALTER TABLE post_performance_snapshots
  ALTER COLUMN source_job_id DROP NOT NULL;

ALTER TABLE post_performance_snapshots
  ADD COLUMN IF NOT EXISTS manual_handling_id UUID
    REFERENCES plan_operator_scheduled_posts(id);

ALTER TABLE post_performance_snapshots
  DROP CONSTRAINT IF EXISTS post_performance_snapshots_source_check;

ALTER TABLE post_performance_snapshots
  ADD CONSTRAINT post_performance_snapshots_source_check
    CHECK (
      (source_job_id IS NOT NULL AND manual_handling_id IS NULL)
      OR (source_job_id IS NULL AND manual_handling_id IS NOT NULL)
    );

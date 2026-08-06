CREATE TABLE IF NOT EXISTS plan_operator_scheduled_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notion_page_id TEXT NOT NULL UNIQUE,
  idempotency_key UUID NOT NULL UNIQUE,
  notion_last_edited_time TEXT NOT NULL,
  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
  recorded_by TEXT NOT NULL DEFAULT 'plan',
  recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reconciled_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS plan_operator_scheduled_posts_state_idx
  ON plan_operator_scheduled_posts (reconciled_at, recorded_at DESC);

CREATE OR REPLACE FUNCTION prevent_operator_scheduled_local_dispatch()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status NOT IN ('failed', 'reconciled', 'succeeded')
     AND EXISTS (
       SELECT 1
       FROM plan_operator_scheduled_posts
       WHERE notion_page_id = NEW.notion_page_id
         AND reconciled_at IS NULL
     ) THEN
    RAISE EXCEPTION 'operator-scheduled post % is not dispatchable', NEW.notion_page_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guard_operator_scheduled_local_dispatch ON local_publish_jobs;
CREATE TRIGGER guard_operator_scheduled_local_dispatch
BEFORE INSERT OR UPDATE OF notion_page_id, status ON local_publish_jobs
FOR EACH ROW EXECUTE FUNCTION prevent_operator_scheduled_local_dispatch();

CREATE OR REPLACE FUNCTION prevent_operator_scheduled_batch_dispatch()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state NOT IN ('invalidated', 'failed', 'reconciled')
     AND EXISTS (
       SELECT 1
       FROM plan_operator_scheduled_posts
       WHERE notion_page_id = NEW.notion_page_id
         AND reconciled_at IS NULL
     ) THEN
    RAISE EXCEPTION 'operator-scheduled post % cannot enter a publish batch', NEW.notion_page_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guard_operator_scheduled_batch_dispatch
  ON rednote_publish_batch_items;
CREATE TRIGGER guard_operator_scheduled_batch_dispatch
BEFORE INSERT OR UPDATE OF notion_page_id, state ON rednote_publish_batch_items
FOR EACH ROW EXECUTE FUNCTION prevent_operator_scheduled_batch_dispatch();

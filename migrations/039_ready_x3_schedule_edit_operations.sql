CREATE TABLE IF NOT EXISTS ready_x3_schedule_edit_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL
    CHECK (char_length(workspace_id) BETWEEN 1 AND 128),
  source_notion_page_id TEXT NOT NULL
    CHECK (char_length(source_notion_page_id) > 0),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 16 AND 200),
  source_revision_before TEXT NOT NULL
    CHECK (char_length(source_revision_before) BETWEEN 1 AND 128),
  source_revision_after TEXT
    CHECK (source_revision_after IS NULL OR char_length(source_revision_after) BETWEEN 1 AND 128),
  publish_at_before TIMESTAMP WITH TIME ZONE NOT NULL,
  scheduled_date_after TEXT
    CHECK (scheduled_date_after IS NULL OR char_length(scheduled_date_after) <= 200),
  publish_at_after TIMESTAMP WITH TIME ZONE,
  packet_identity TEXT NOT NULL CHECK (packet_identity ~ '^[a-f0-9]{64}$'),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('retarget', 'invalidate')),
  state TEXT NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'committed', 'consent_cleared', 'aborted')),
  parent_attempt_id UUID NOT NULL
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  parent_local_publish_job_id UUID NOT NULL
    REFERENCES local_publish_jobs(id) ON DELETE RESTRICT,
  retargeted_attempt_id UUID
    REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  retargeted_local_publish_job_id UUID
    REFERENCES local_publish_jobs(id) ON DELETE RESTRICT,
  state_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT ready_x3_schedule_edit_terminal_check CHECK (
    (state = 'prepared' AND completed_at IS NULL)
    OR (state <> 'prepared' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT ready_x3_schedule_edit_retarget_check CHECK (
    (state = 'committed'
      AND operation_kind = 'retarget'
      AND retargeted_attempt_id IS NOT NULL
      AND retargeted_local_publish_job_id IS NOT NULL)
    OR (state <> 'committed'
      AND retargeted_attempt_id IS NULL
      AND retargeted_local_publish_job_id IS NULL)
  ),
  CONSTRAINT ready_x3_schedule_edit_target_check CHECK (
    operation_kind <> 'retarget'
    OR (scheduled_date_after IS NOT NULL AND publish_at_after IS NOT NULL)
  ),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS ready_x3_schedule_edit_one_pending_post_idx
  ON ready_x3_schedule_edit_operations (workspace_id, source_notion_page_id)
  WHERE state = 'prepared';

CREATE INDEX IF NOT EXISTS ready_x3_schedule_edit_parent_attempt_idx
  ON ready_x3_schedule_edit_operations (workspace_id, parent_attempt_id, created_at DESC);

-- These row-local pointers make claim predicates safe under READ COMMITTED:
-- a claim that waited on the row lock rechecks the updated row version and
-- cannot miss a pending operation inserted in the preparation transaction.
ALTER TABLE local_publish_jobs
  ADD COLUMN IF NOT EXISTS ready_x3_schedule_edit_hold_id UUID
    REFERENCES ready_x3_schedule_edit_operations(id) ON DELETE RESTRICT;

ALTER TABLE rednote_publish_attempts
  ADD COLUMN IF NOT EXISTS ready_x3_schedule_edit_hold_id UUID
    REFERENCES ready_x3_schedule_edit_operations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS local_publish_jobs_schedule_edit_hold_idx
  ON local_publish_jobs (ready_x3_schedule_edit_hold_id)
  WHERE ready_x3_schedule_edit_hold_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS rednote_publish_attempts_schedule_edit_hold_idx
  ON rednote_publish_attempts (ready_x3_schedule_edit_hold_id)
  WHERE ready_x3_schedule_edit_hold_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ready_x3_schedule_edit_operation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL
    REFERENCES ready_x3_schedule_edit_operations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('prepared', 'retargeted', 'consent_cleared', 'aborted')),
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('operator', 'admin', 'system')),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 160),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE INDEX IF NOT EXISTS ready_x3_schedule_edit_events_timeline_idx
  ON ready_x3_schedule_edit_operation_events (operation_id, occurred_at, id);

CREATE OR REPLACE FUNCTION guard_ready_x3_schedule_edit_operation_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.source_notion_page_id IS DISTINCT FROM OLD.source_notion_page_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.source_revision_before IS DISTINCT FROM OLD.source_revision_before
     OR NEW.publish_at_before IS DISTINCT FROM OLD.publish_at_before
     OR NEW.scheduled_date_after IS DISTINCT FROM OLD.scheduled_date_after
     OR NEW.publish_at_after IS DISTINCT FROM OLD.publish_at_after
     OR NEW.packet_identity IS DISTINCT FROM OLD.packet_identity
     OR NEW.operation_kind IS DISTINCT FROM OLD.operation_kind
     OR NEW.parent_attempt_id IS DISTINCT FROM OLD.parent_attempt_id
     OR NEW.parent_local_publish_job_id IS DISTINCT FROM OLD.parent_local_publish_job_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Ready x3 schedule edit identity is immutable';
  END IF;

  IF OLD.state <> 'prepared'
     AND (NEW.state IS DISTINCT FROM OLD.state
       OR NEW.source_revision_after IS DISTINCT FROM OLD.source_revision_after
       OR NEW.retargeted_attempt_id IS DISTINCT FROM OLD.retargeted_attempt_id
       OR NEW.retargeted_local_publish_job_id IS DISTINCT FROM OLD.retargeted_local_publish_job_id
       OR NEW.state_reason IS DISTINCT FROM OLD.state_reason
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'Ready x3 schedule edit terminal state is immutable';
  END IF;

  IF OLD.state = 'prepared'
     AND NEW.state NOT IN ('prepared', 'committed', 'consent_cleared', 'aborted') THEN
    RAISE EXCEPTION 'Invalid Ready x3 schedule edit transition';
  END IF;
  IF OLD.state = 'prepared'
     AND NEW.state <> 'prepared'
     AND (
       EXISTS (
         SELECT 1 FROM local_publish_jobs
         WHERE ready_x3_schedule_edit_hold_id=OLD.id
       )
       OR EXISTS (
         SELECT 1 FROM rednote_publish_attempts
         WHERE ready_x3_schedule_edit_hold_id=OLD.id
       )
     ) THEN
    RAISE EXCEPTION 'Ready x3 schedule edit holds must be released before completion';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ready_x3_schedule_edit_operation_immutable
  ON ready_x3_schedule_edit_operations;
CREATE TRIGGER ready_x3_schedule_edit_operation_immutable
BEFORE UPDATE ON ready_x3_schedule_edit_operations
FOR EACH ROW EXECUTE FUNCTION guard_ready_x3_schedule_edit_operation_update();

CREATE OR REPLACE FUNCTION guard_ready_x3_schedule_edit_hold_pointer()
RETURNS trigger AS $$
DECLARE
  held_operation ready_x3_schedule_edit_operations%ROWTYPE;
  page_id TEXT;
BEGIN
  IF NEW.ready_x3_schedule_edit_hold_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'local_publish_jobs' THEN
    page_id := NEW.notion_page_id;
  ELSE
    page_id := NEW.source_notion_page_id;
  END IF;
  SELECT * INTO held_operation
  FROM ready_x3_schedule_edit_operations
  WHERE id = NEW.ready_x3_schedule_edit_hold_id;
  IF held_operation.id IS NULL
     OR held_operation.state <> 'prepared'
     OR held_operation.workspace_id <> NEW.workspace_id
     OR held_operation.source_notion_page_id <> page_id THEN
    RAISE EXCEPTION 'Ready x3 schedule edit hold must reference a matching prepared operation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS local_publish_jobs_schedule_edit_hold_guard
  ON local_publish_jobs;
CREATE TRIGGER local_publish_jobs_schedule_edit_hold_guard
BEFORE INSERT OR UPDATE OF ready_x3_schedule_edit_hold_id ON local_publish_jobs
FOR EACH ROW EXECUTE FUNCTION guard_ready_x3_schedule_edit_hold_pointer();

DROP TRIGGER IF EXISTS rednote_publish_attempts_schedule_edit_hold_guard
  ON rednote_publish_attempts;
CREATE TRIGGER rednote_publish_attempts_schedule_edit_hold_guard
BEFORE INSERT OR UPDATE OF ready_x3_schedule_edit_hold_id ON rednote_publish_attempts
FOR EACH ROW EXECUTE FUNCTION guard_ready_x3_schedule_edit_hold_pointer();

CREATE OR REPLACE FUNCTION prevent_ready_x3_schedule_edit_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Ready x3 schedule edit events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ready_x3_schedule_edit_event_immutable
  ON ready_x3_schedule_edit_operation_events;
CREATE TRIGGER ready_x3_schedule_edit_event_immutable
BEFORE UPDATE OR DELETE ON ready_x3_schedule_edit_operation_events
FOR EACH ROW EXECUTE FUNCTION prevent_ready_x3_schedule_edit_event_mutation();

DROP TRIGGER IF EXISTS ready_x3_schedule_edit_event_truncate_guard
  ON ready_x3_schedule_edit_operation_events;
CREATE TRIGGER ready_x3_schedule_edit_event_truncate_guard
BEFORE TRUNCATE ON ready_x3_schedule_edit_operation_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_ready_x3_schedule_edit_event_mutation();
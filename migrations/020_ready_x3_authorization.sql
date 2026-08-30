ALTER TABLE rednote_publish_attempts
  ADD COLUMN IF NOT EXISTS authorization_kind TEXT
    CHECK (authorization_kind IS NULL OR authorization_kind = 'ready_x3'),
  ADD COLUMN IF NOT EXISTS late_fallback_policy JSONB
    CHECK (
      late_fallback_policy IS NULL OR (
        late_fallback_policy = '{"action":"schedule","maxLateMinutes":30}'::jsonb
        OR late_fallback_policy = '{"action":"post_now","maxLateMinutes":30}'::jsonb
      )
    );

ALTER TABLE rednote_publish_attempts
  DROP CONSTRAINT IF EXISTS rednote_ready_x3_authorization_check;
ALTER TABLE rednote_publish_attempts
  ADD CONSTRAINT rednote_ready_x3_authorization_check CHECK (
    (authorization_kind IS NULL AND late_fallback_policy IS NULL)
    OR (
      authorization_kind = 'ready_x3'
      AND approved_at IS NOT NULL
      AND executor_type = 'worker'
      AND target_publish_at IS NOT NULL
      AND late_fallback_policy IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION guard_ready_x3_authorization_immutable()
RETURNS trigger AS $$
BEGIN
  IF OLD.authorization_kind IS NOT NULL
     AND (NEW.authorization_kind IS DISTINCT FROM OLD.authorization_kind
       OR NEW.late_fallback_policy IS DISTINCT FROM OLD.late_fallback_policy) THEN
    RAISE EXCEPTION 'Ready x3 authorization is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ready_x3_authorization_immutable ON rednote_publish_attempts;
CREATE TRIGGER ready_x3_authorization_immutable
BEFORE UPDATE ON rednote_publish_attempts
FOR EACH ROW EXECUTE FUNCTION guard_ready_x3_authorization_immutable();
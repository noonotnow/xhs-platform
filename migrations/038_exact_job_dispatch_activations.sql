CREATE TABLE IF NOT EXISTS local_publish_dispatch_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL CHECK (char_length(workspace_id) BETWEEN 1 AND 200),
  local_publish_job_id UUID NOT NULL REFERENCES local_publish_jobs(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES rednote_publish_batches(id) ON DELETE RESTRICT,
  batch_item_id UUID NOT NULL REFERENCES rednote_publish_batch_items(id) ON DELETE RESTRICT,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  item_hash TEXT NOT NULL CHECK (item_hash ~ '^[a-f0-9]{64}$'),
  source_revision TEXT NOT NULL CHECK (char_length(source_revision) BETWEEN 1 AND 200),
  expected_worker_id TEXT NOT NULL CHECK (char_length(expected_worker_id) BETWEEN 1 AND 200),
  expected_worker_contract_revision TEXT NOT NULL
    CHECK (char_length(expected_worker_contract_revision) BETWEEN 1 AND 100),
  expected_worker_compatibility_revision TEXT NOT NULL
    CHECK (char_length(expected_worker_compatibility_revision) BETWEEN 1 AND 100),
  expected_worker_release_id TEXT NOT NULL
    CHECK (
      char_length(expected_worker_release_id) BETWEEN 1 AND 200
      AND expected_worker_release_id = btrim(expected_worker_release_id)
    ),
  expected_worker_attestation_id TEXT NOT NULL
    CHECK (
      char_length(expected_worker_attestation_id) BETWEEN 1 AND 200
      AND expected_worker_attestation_id =
        btrim(expected_worker_attestation_id)
    ),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  nonce_digest TEXT NOT NULL CHECK (nonce_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'active', 'consumed', 'released', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 320),
  authorized_at TIMESTAMP WITH TIME ZONE,
  authorized_by TEXT CHECK (authorized_by IS NULL OR char_length(authorized_by) BETWEEN 1 AND 320),
  consumed_at TIMESTAMP WITH TIME ZONE,
  consumed_by TEXT CHECK (consumed_by IS NULL OR char_length(consumed_by) BETWEEN 1 AND 320),
  released_at TIMESTAMP WITH TIME ZONE,
  released_by TEXT CHECK (released_by IS NULL OR char_length(released_by) BETWEEN 1 AND 320),
  release_reason TEXT CHECK (release_reason IS NULL OR char_length(release_reason) BETWEEN 1 AND 500),
  cancelled_at TIMESTAMP WITH TIME ZONE,
  cancelled_by TEXT CHECK (cancelled_by IS NULL OR char_length(cancelled_by) BETWEEN 1 AND 320),
  cancellation_reason TEXT
    CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) BETWEEN 1 AND 500),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT local_publish_dispatch_activation_timestamps_check CHECK (
    expires_at > created_at
    AND (
      (state = 'prepared'
        AND authorized_at IS NULL AND authorized_by IS NULL
        AND consumed_at IS NULL AND consumed_by IS NULL
        AND released_at IS NULL AND released_by IS NULL AND release_reason IS NULL
        AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancellation_reason IS NULL)
      OR
      (state = 'active'
        AND authorized_at IS NOT NULL AND authorized_by IS NOT NULL
        AND consumed_at IS NULL AND consumed_by IS NULL
        AND released_at IS NULL AND released_by IS NULL AND release_reason IS NULL
        AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancellation_reason IS NULL)
      OR
      (state = 'consumed'
        AND authorized_at IS NOT NULL AND authorized_by IS NOT NULL
        AND consumed_at IS NOT NULL AND consumed_by IS NOT NULL
        AND released_at IS NULL AND released_by IS NULL AND release_reason IS NULL
        AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancellation_reason IS NULL)
      OR
      (state = 'released'
        AND authorized_at IS NOT NULL AND authorized_by IS NOT NULL
        AND released_at IS NOT NULL AND released_by IS NOT NULL
        AND release_reason IS NOT NULL
        AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancellation_reason IS NULL)
      OR
      (state = 'cancelled'
        AND (
          (authorized_at IS NULL AND authorized_by IS NULL)
          OR
          (authorized_at IS NOT NULL AND authorized_by IS NOT NULL)
        )
        AND consumed_at IS NULL AND consumed_by IS NULL
        AND released_at IS NULL AND released_by IS NULL AND release_reason IS NULL
        AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
        AND cancellation_reason IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS local_publish_dispatch_activation_identity_idx
  ON local_publish_dispatch_activations (local_publish_job_id, generation)
  WHERE state <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS local_publish_dispatch_activation_exclusive_hold_idx
  ON local_publish_dispatch_activations ((true))
  WHERE state IN ('active', 'consumed');

CREATE INDEX IF NOT EXISTS local_publish_dispatch_activation_job_idx
  ON local_publish_dispatch_activations (local_publish_job_id, state);

CREATE TABLE IF NOT EXISTS local_publish_dispatch_activation_events (
  id BIGSERIAL PRIMARY KEY,
  activation_id UUID NOT NULL
    REFERENCES local_publish_dispatch_activations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('prepared', 'activated', 'consumed', 'released', 'cancelled')
  ),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'worker')),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 320),
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT local_publish_dispatch_activation_event_unique
    UNIQUE (activation_id, event_type)
);

CREATE OR REPLACE FUNCTION guard_local_publish_dispatch_activation_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.local_publish_job_id <> OLD.local_publish_job_id
    OR NEW.batch_id <> OLD.batch_id
    OR NEW.batch_item_id <> OLD.batch_item_id
    OR NEW.manifest_hash <> OLD.manifest_hash
    OR NEW.item_hash <> OLD.item_hash
    OR NEW.source_revision <> OLD.source_revision
    OR NEW.expected_worker_id <> OLD.expected_worker_id
    OR NEW.expected_worker_contract_revision <> OLD.expected_worker_contract_revision
    OR NEW.expected_worker_compatibility_revision <> OLD.expected_worker_compatibility_revision
    OR NEW.expected_worker_release_id <> OLD.expected_worker_release_id
    OR NEW.expected_worker_attestation_id <> OLD.expected_worker_attestation_id
    OR NEW.generation <> OLD.generation
    OR NEW.nonce_digest <> OLD.nonce_digest
    OR NEW.created_at <> OLD.created_at
    OR NEW.created_by <> OLD.created_by
    OR NEW.expires_at <> OLD.expires_at
  THEN
    RAISE EXCEPTION 'dispatch activation identity is immutable';
  END IF;
  IF NOT (
    (OLD.state = 'prepared' AND NEW.state = 'active')
    OR (OLD.state = 'prepared' AND NEW.state = 'cancelled')
    OR (OLD.state = 'active' AND NEW.state IN ('consumed', 'cancelled'))
    OR (OLD.state = 'consumed' AND NEW.state = 'released')
  ) THEN
    RAISE EXCEPTION 'invalid dispatch activation state transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS local_publish_dispatch_activation_mutation_guard
  ON local_publish_dispatch_activations;
CREATE TRIGGER local_publish_dispatch_activation_mutation_guard
BEFORE UPDATE ON local_publish_dispatch_activations
FOR EACH ROW EXECUTE FUNCTION guard_local_publish_dispatch_activation_mutation();

CREATE OR REPLACE FUNCTION prevent_local_publish_dispatch_activation_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'dispatch activations are durable and cannot be deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS local_publish_dispatch_activation_delete_guard
  ON local_publish_dispatch_activations;
CREATE TRIGGER local_publish_dispatch_activation_delete_guard
BEFORE DELETE ON local_publish_dispatch_activations
FOR EACH ROW EXECUTE FUNCTION prevent_local_publish_dispatch_activation_delete();

DROP TRIGGER IF EXISTS local_publish_dispatch_activation_truncate_guard
  ON local_publish_dispatch_activations;
CREATE TRIGGER local_publish_dispatch_activation_truncate_guard
BEFORE TRUNCATE ON local_publish_dispatch_activations
FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_publish_dispatch_activation_delete();

CREATE OR REPLACE FUNCTION prevent_local_publish_dispatch_activation_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'dispatch activation events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS local_publish_dispatch_activation_events_append_only
  ON local_publish_dispatch_activation_events;
CREATE TRIGGER local_publish_dispatch_activation_events_append_only
BEFORE UPDATE OR DELETE ON local_publish_dispatch_activation_events
FOR EACH ROW EXECUTE FUNCTION prevent_local_publish_dispatch_activation_event_mutation();

DROP TRIGGER IF EXISTS local_publish_dispatch_activation_events_truncate_guard
  ON local_publish_dispatch_activation_events;
CREATE TRIGGER local_publish_dispatch_activation_events_truncate_guard
BEFORE TRUNCATE ON local_publish_dispatch_activation_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_publish_dispatch_activation_event_mutation();

CREATE OR REPLACE FUNCTION active_local_publish_dispatch_activation()
RETURNS SETOF local_publish_dispatch_activations
LANGUAGE SQL
STABLE
AS $$
  SELECT *
  FROM local_publish_dispatch_activations
  WHERE state IN ('active', 'consumed')
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION guard_dispatch_eligibility_during_activation()
RETURNS TRIGGER AS $$
DECLARE
  hold local_publish_dispatch_activations%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('local-publish-dispatch-activation', 0)
  );
  SELECT * INTO hold FROM active_local_publish_dispatch_activation();
  IF hold.id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'rednote_publish_batches' THEN
    IF NEW.status IN ('approved', 'partially_approved')
      AND (
        TG_OP = 'INSERT'
        OR OLD.status IS DISTINCT FROM NEW.status
      )
    THEN
      RAISE EXCEPTION 'DISPATCH_ACTIVATION_HOLD_ACTIVE';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'local_publish_jobs' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'DISPATCH_ACTIVATION_HOLD_ACTIVE';
    END IF;
    IF NEW.status IN ('queued', 'claimed')
      AND OLD.status IS DISTINCT FROM NEW.status
      AND NEW.id <> hold.local_publish_job_id
    THEN
      RAISE EXCEPTION 'DISPATCH_ACTIVATION_HOLD_ACTIVE';
    END IF;
    IF NEW.status = 'queued'
      AND OLD.status IS DISTINCT FROM NEW.status
      AND NEW.id = hold.local_publish_job_id
      AND hold.state <> 'active'
    THEN
      RAISE EXCEPTION 'DISPATCH_ACTIVATION_NOT_ACTIVE';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'rednote_publish_attempts' THEN
    IF (
      (TG_OP = 'INSERT' AND NEW.approved_at IS NOT NULL AND NEW.active)
      OR (
        TG_OP = 'UPDATE'
        AND NEW.approved_at IS NOT NULL AND NEW.active
        AND (OLD.approved_at IS NULL OR NOT OLD.active)
      )
    ) THEN
      IF NEW.source_local_publish_job_id IS DISTINCT FROM hold.local_publish_job_id
        OR NEW.workspace_id <> hold.workspace_id
        OR NEW.payload_revision <> hold.source_revision
        OR hold.state <> 'active'
      THEN
        RAISE EXCEPTION 'DISPATCH_ACTIVATION_HOLD_ACTIVE';
      END IF;
      IF TG_OP = 'INSERT' AND NEW.supersedes_attempt_id IS NULL THEN
        RAISE EXCEPTION 'DISPATCH_ACTIVATION_EXACT_RECOVERY_REQUIRED';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rednote_publish_batch_activation_hold
  ON rednote_publish_batches;
DROP TRIGGER IF EXISTS rednote_publish_batch_insert_activation_hold
  ON rednote_publish_batches;
DROP TRIGGER IF EXISTS rednote_publish_batch_status_activation_hold
  ON rednote_publish_batches;
CREATE TRIGGER rednote_publish_batch_insert_activation_hold
BEFORE INSERT ON rednote_publish_batches
FOR EACH ROW EXECUTE FUNCTION guard_dispatch_eligibility_during_activation();
CREATE TRIGGER rednote_publish_batch_status_activation_hold
BEFORE UPDATE OF status ON rednote_publish_batches
FOR EACH ROW EXECUTE FUNCTION guard_dispatch_eligibility_during_activation();

DROP TRIGGER IF EXISTS local_publish_job_activation_hold
  ON local_publish_jobs;
DROP TRIGGER IF EXISTS local_publish_job_insert_activation_hold
  ON local_publish_jobs;
DROP TRIGGER IF EXISTS local_publish_job_status_activation_hold
  ON local_publish_jobs;
CREATE TRIGGER local_publish_job_insert_activation_hold
BEFORE INSERT ON local_publish_jobs
FOR EACH ROW EXECUTE FUNCTION guard_dispatch_eligibility_during_activation();
CREATE TRIGGER local_publish_job_status_activation_hold
BEFORE UPDATE OF status ON local_publish_jobs
FOR EACH ROW EXECUTE FUNCTION guard_dispatch_eligibility_during_activation();

DROP TRIGGER IF EXISTS rednote_publish_attempt_activation_hold
  ON rednote_publish_attempts;
DROP TRIGGER IF EXISTS rednote_publish_attempt_insert_activation_hold
  ON rednote_publish_attempts;
DROP TRIGGER IF EXISTS rednote_publish_attempt_status_activation_hold
  ON rednote_publish_attempts;
CREATE TRIGGER rednote_publish_attempt_insert_activation_hold
BEFORE INSERT ON rednote_publish_attempts
FOR EACH ROW EXECUTE FUNCTION guard_dispatch_eligibility_during_activation();
CREATE TRIGGER rednote_publish_attempt_status_activation_hold
BEFORE UPDATE OF approved_at, active ON rednote_publish_attempts
FOR EACH ROW EXECUTE FUNCTION guard_dispatch_eligibility_during_activation();

CREATE OR REPLACE FUNCTION exact_job_dispatch_activation_revision()
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$ SELECT '038'::TEXT $$;

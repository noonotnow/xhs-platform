-- This is deliberately a workspace singleton: it reports the worker currently
-- responsible for that workspace, not a history of browsers or credentials.
CREATE TABLE IF NOT EXISTS local_publish_worker_heartbeats (
  workspace_id TEXT PRIMARY KEY
    CHECK (workspace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  worker_id TEXT NOT NULL
    CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  contract_revision TEXT NOT NULL
    CHECK (char_length(contract_revision) BETWEEN 1 AND 128),
  compatibility_revision TEXT NOT NULL
    CHECK (char_length(compatibility_revision) BETWEEN 1 AND 128),
  polling_interval_seconds INTEGER NOT NULL
    CHECK (polling_interval_seconds BETWEEN 5 AND 86400),
  last_poll_at TIMESTAMP WITH TIME ZONE NOT NULL,
  next_poll_at TIMESTAMP WITH TIME ZONE NOT NULL,
  last_heartbeat_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (next_poll_at >= last_poll_at)
);

CREATE INDEX IF NOT EXISTS local_publish_worker_heartbeats_lease_idx
  ON local_publish_worker_heartbeats (lease_expires_at);
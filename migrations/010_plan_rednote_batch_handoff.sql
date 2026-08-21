-- Records a PLAN-originated Rednote batch manifest and per-item approval state.
-- batch_id and manifest_id come from PLAN's manifest payload;
-- idempotency_key is the per-request Idempotency-Key header value.

CREATE TABLE IF NOT EXISTS plan_rednote_batch_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id TEXT NOT NULL UNIQUE,
  manifest_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  handoff_mode TEXT NOT NULL DEFAULT 'queue',
  publish_policy TEXT NOT NULL DEFAULT 'explicit-approval-only',
  manifest_json JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'partially_approved', 'fully_approved')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plan_rednote_batch_manifest_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_pk UUID NOT NULL REFERENCES plan_rednote_batch_manifests(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  notion_page_id TEXT NOT NULL,
  notion_version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'approved', 'rejected')),
  rejection_reason TEXT
    CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 500),
  approval_idempotency_key TEXT
    CHECK (approval_idempotency_key IS NULL OR char_length(approval_idempotency_key) BETWEEN 1 AND 256),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (batch_id, item_id),
  UNIQUE (batch_id, notion_page_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS plan_rednote_batch_manifest_items_approval_key_idx
  ON plan_rednote_batch_manifest_items (approval_idempotency_key)
  WHERE approval_idempotency_key IS NOT NULL;

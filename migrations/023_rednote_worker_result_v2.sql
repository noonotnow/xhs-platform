ALTER TABLE local_publish_jobs
  ADD COLUMN IF NOT EXISTS receipt_contract_version TEXT,
  ADD COLUMN IF NOT EXISTS receipt_outcome TEXT,
  ADD COLUMN IF NOT EXISTS receipt_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS authenticated_account_id TEXT,
  ADD COLUMN IF NOT EXISTS authenticated_account_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS xsec_accessible_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS public_index_status TEXT,
  ADD COLUMN IF NOT EXISTS public_index_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_restriction_status TEXT,
  ADD COLUMN IF NOT EXISTS provider_restriction_reported_at TIMESTAMPTZ;

ALTER TABLE local_publish_jobs
  DROP CONSTRAINT IF EXISTS local_publish_jobs_receipt_outcome_check,
  ADD CONSTRAINT local_publish_jobs_receipt_outcome_check
    CHECK (
      receipt_outcome IS NULL
      OR receipt_outcome IN ('acknowledged', 'scheduled', 'ambiguous', 'rejected')
    ),
  DROP CONSTRAINT IF EXISTS local_publish_jobs_public_index_status_check,
  ADD CONSTRAINT local_publish_jobs_public_index_status_check
    CHECK (
      public_index_status IS NULL
      OR public_index_status IN ('indexed', 'pending', 'not_found')
    ),
  DROP CONSTRAINT IF EXISTS local_publish_jobs_provider_restriction_check,
  ADD CONSTRAINT local_publish_jobs_provider_restriction_check
    CHECK (
      provider_restriction_status IS NULL
      OR provider_restriction_status IN ('removed', 'restricted')
    );

ALTER TABLE rednote_publish_attempt_receipts
  ALTER COLUMN rednote_url DROP NOT NULL;

ALTER TABLE rednote_publish_attempt_receipts
  DROP CONSTRAINT IF EXISTS rednote_publish_attempt_receipts_identity_check,
  ADD CONSTRAINT rednote_publish_attempt_receipts_identity_check
    CHECK (
      rednote_note_id = split_part(rednote_note_id, '?', 1)
      AND rednote_note_id = split_part(rednote_note_id, '#', 1)
      AND (
        rednote_url IS NULL
        OR rednote_url = 'https://www.rednote.com/explore/' || rednote_note_id
        OR rednote_url = 'https://www.xiaohongshu.com/explore/' || rednote_note_id
      )
    );

CREATE OR REPLACE FUNCTION guard_rednote_publish_attempt_receipt_insert()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rednote_publish_attempts
    WHERE id = NEW.attempt_id
      AND terminal_outcome IN ('accepted', 'outcome_unknown')
      AND receipt_lookup_state = 'found'
      AND NOT active
      AND superseded_by_attempt_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'receipt capture requires an inactive accepted or outcome-unknown attempt in found state';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS rednote_publication_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL DEFAULT 'legacy-local-publish',
  local_publish_job_id UUID REFERENCES local_publish_jobs(id) ON DELETE RESTRICT,
  attempt_id UUID REFERENCES rednote_publish_attempts(id) ON DELETE RESTRICT,
  note_id TEXT,
  evidence_kind TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  account_id TEXT,
  evidence_status TEXT NOT NULL,
  public_url TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT rednote_publication_evidence_kind_check
    CHECK (
      evidence_kind IN (
        'authenticated_account',
        'xsec_access',
        'public_index',
        'removed_restricted'
      )
    ),
  CONSTRAINT rednote_publication_evidence_no_secret_fields
    CHECK (
      NOT details ?| ARRAY[
        'token',
        'xsecToken',
        'xsec_token',
        'cookie',
        'cookies',
        'authorization'
      ]
    ),
  CONSTRAINT rednote_publication_evidence_shape_check
    CHECK (
      (evidence_kind = 'authenticated_account'
        AND account_id IS NOT NULL
        AND (note_id IS NOT NULL OR local_publish_job_id IS NOT NULL)
        AND evidence_status IN ('owned', 'account_mismatch')
        AND public_url IS NULL)
      OR
      (evidence_kind = 'xsec_access'
        AND note_id IS NOT NULL
        AND account_id IS NULL
        AND evidence_status = 'accessible'
        AND public_url IS NULL)
      OR
      (evidence_kind = 'public_index'
        AND note_id IS NOT NULL
        AND account_id IS NULL
        AND evidence_status IN ('indexed', 'pending', 'not_found')
        AND (
          (evidence_status = 'indexed'
            AND (
              public_url IS NULL
              OR public_url = 'https://www.rednote.com/explore/' || note_id
              OR public_url = 'https://www.xiaohongshu.com/explore/' || note_id
            ))
          OR
          (evidence_status IN ('pending', 'not_found') AND public_url IS NULL)
        ))
      OR
      (evidence_kind = 'removed_restricted'
        AND note_id IS NOT NULL
        AND account_id IS NULL
        AND evidence_status IN ('removed', 'restricted')
        AND public_url IS NULL)
    )
);

ALTER TABLE rednote_publication_evidence
  ALTER COLUMN note_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rednote_publication_evidence_note
  ON rednote_publication_evidence (workspace_id, note_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_rednote_publication_evidence_job
  ON rednote_publication_evidence (local_publish_job_id, captured_at DESC)
  WHERE local_publish_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_rednote_publication_evidence_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rednote_publication_evidence is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rednote_publication_evidence_no_update
  ON rednote_publication_evidence;
CREATE TRIGGER rednote_publication_evidence_no_update
BEFORE UPDATE OR DELETE ON rednote_publication_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_rednote_publication_evidence_mutation();

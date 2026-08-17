ALTER TABLE local_publish_job_success_attestations
  ADD COLUMN IF NOT EXISTS provenance TEXT NOT NULL DEFAULT 'worker_ambiguous';

ALTER TABLE local_publish_job_success_attestations
  DROP CONSTRAINT IF EXISTS local_publish_job_success_attestations_provenance_check;
ALTER TABLE local_publish_job_success_attestations
  ADD CONSTRAINT local_publish_job_success_attestations_provenance_check
    CHECK (provenance IN ('worker_ambiguous', 'manual_scheduled'));

ALTER TABLE local_publish_job_success_attestations
  ALTER COLUMN prior_claim_token_digest DROP NOT NULL;

ALTER TABLE local_publish_job_success_attestations
  DROP CONSTRAINT IF EXISTS local_publish_job_success_attestations_contract_revision_check;
ALTER TABLE local_publish_job_success_attestations
  ADD CONSTRAINT local_publish_job_success_attestations_contract_revision_check
    CHECK (contract_revision IN (
      'operator-success-attestation/v1',
      'manual-scheduling-attestation/v1'
    ));

ALTER TABLE local_publish_job_success_attestations
  DROP CONSTRAINT IF EXISTS local_publish_job_success_attestations_provenance_evidence_check;
ALTER TABLE local_publish_job_success_attestations
  ADD CONSTRAINT local_publish_job_success_attestations_provenance_evidence_check
    CHECK (
      (
        provenance = 'worker_ambiguous'
        AND contract_revision = 'operator-success-attestation/v1'
        AND prior_claim_token_digest IS NOT NULL
      )
      OR (
        provenance = 'manual_scheduled'
        AND contract_revision = 'manual-scheduling-attestation/v1'
        AND prior_claim_token_digest IS NULL
      )
    );

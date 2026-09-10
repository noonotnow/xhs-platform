import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('generation-aware recovery migration', () => {
  it('replaces row uniqueness with attempt-scoped uniqueness without mutating audit rows', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/011_generation_aware_rednote_publish_job_recoveries.sql'),
      'utf8',
    );
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS rednote_publish_job_recoveries_local_publish_job_id_key',
    );
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS rednote_publish_job_recoveries_batch_item_id_key',
    );
    expect(migration).toContain('UNIQUE (local_publish_job_id, prior_claim_attempts)');
    expect(migration).toContain('UNIQUE (batch_item_id, prior_claim_attempts)');
    expect(migration).not.toMatch(/\bUPDATE\b|\bDELETE FROM\b/i);

    const original = readFileSync(
      join(process.cwd(), 'migrations/010_rednote_publish_job_recoveries.sql'),
      'utf8',
    );
    expect(original).toContain('BEFORE UPDATE OR DELETE');
    expect(original).toContain('prevent_rednote_publish_job_recovery_mutation');
  });

  it('adds only the exact image-mode hydration error to the audit allowlist', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/012_recover_fixed_image_mode_hydration.sql'),
      'utf8',
    );
    expect(migration).toContain(
      'DROP CONSTRAINT rednote_publish_job_recoveries_prior_error_code_check',
    );
    expect(migration).toContain("'BOUNDED_BATCH_BYPASS_DISABLED'");
    expect(migration).toContain("'AMBIGUOUS_CREATOR_UI'");
    expect(migration).not.toMatch(/\bUPDATE\b|\bDELETE FROM\b|\bINSERT INTO\b/i);
    expect(migration).not.toContain('prevent_rednote_publish_job_recovery_mutation');
  });

  it('adds only the login-required code to the existing recovery audit allowlist', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/032_recover_creator_login_failure.sql'),
      'utf8',
    );
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS rednote_publish_job_recoveries_prior_error_code_check',
    );
    expect(migration).toContain("'BOUNDED_BATCH_BYPASS_DISABLED'");
    expect(migration).toContain("'AMBIGUOUS_CREATOR_UI'");
    expect(migration).toContain("'NOT_LOGGED_IN'");
    expect(migration).not.toMatch(/\bUPDATE\b|\bDELETE FROM\b|\bINSERT INTO\b/i);
    expect(migration).not.toContain('prevent_rednote_publish_job_recovery_mutation');
  });

  it('treats only a coherent rejected v2 result as non-publication evidence', () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        'migrations/033_rejected_worker_result_recovery_evidence.sql',
      ),
      'utf8',
    );
    expect(migration).toContain(
      'rednote_publish_excluded_job_has_recovery_evidence',
    );
    expect(migration).toContain(
      "job.receipt_contract_version = 'rednote-worker-result/v2'",
    );
    expect(migration).toContain("job.receipt_outcome = 'rejected'");
    expect(migration).toContain('job.receipt_acknowledged_at IS NOT NULL');
    expect(migration).toContain('rednote_publish_recovery_revision_blockers');
    expect(migration).not.toMatch(/\bUPDATE\b|\bDELETE FROM\b|\bINSERT INTO\b/i);
  });
});

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
      'DROP CONSTRAINT rednote_publish_job_recoveries_local_publish_job_id_key',
    );
    expect(migration).toContain(
      'DROP CONSTRAINT rednote_publish_job_recoveries_batch_item_id_key',
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
});

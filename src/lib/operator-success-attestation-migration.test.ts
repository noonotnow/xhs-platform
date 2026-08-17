import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('operator success attestation migration', () => {
  it('adds an append-only receipt and lifecycle without mutating production rows', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/014_operator_success_attestations.sql'),
      'utf8',
    );
    expect(migration).toContain('local_publish_job_success_attestations');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain("'operator_attested'");
    expect(migration).toContain("'operator-success-attestation/v1'");
    expect(migration).toContain('prior_claim_token_digest');
    expect(migration).toContain('snapshot_digest = item_hash');
    expect(migration).toContain(
      'local_publish_job_success_attestation_release_acks',
    );
    expect(migration).not.toMatch(/\bUPDATE\s+(?!OR\b)|\bDELETE FROM\b|\bINSERT INTO\b/i);
  });
});

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('manual scheduling attestation migration', () => {
  it('adds immutable provenance without rewriting lifecycle rows', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/014_manual_scheduling_attestations.sql'),
      'utf8',
    );
    expect(migration).toContain("'manual_scheduled'");
    expect(migration).toContain("'manual-scheduling-attestation/v1'");
    expect(migration).toContain('prior_claim_token_digest DROP NOT NULL');
    expect(migration).not.toMatch(/\bUPDATE\b|\bDELETE FROM\b|\bINSERT INTO\b/i);
  });
});

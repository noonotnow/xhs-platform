import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('operator success attestation surfaces', () => {
  it('adds append-only schema, terminal states, and no production data mutation', () => {
    const migration = readFileSync(
      'migrations/013_operator_success_attestations.sql',
      'utf8',
    );
    expect(migration).toContain('local_publish_operator_success_attestations');
    expect(migration).toContain("'operator_attested'");
    expect(migration).toContain('prevent_operator_success_attestation_mutation');
    expect(migration).not.toMatch(/\bDELETE FROM\b/i);
  });

  it('renders the explicit action only behind server capability and eligibility', () => {
    const panel = readFileSync('src/app/admin/ReadyPostsPanel.tsx', 'utf8');
    expect(panel).toContain('Yes, this succeeded — move on');
    expect(panel).toContain(
      'currentJob?.successAttestationEligible &&\n                      successAttestationCapabilityAvailable',
    );
    expect(panel).toContain('It does NOT verify publication');
    expect(panel).toContain('Operator attested success; receipt verification pending');
  });
});

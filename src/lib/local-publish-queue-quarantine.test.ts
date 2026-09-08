import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { inventoryLocalPublishQueue } from './local-publish-queue-quarantine';

describe('local publish queue quarantine', () => {
  it('inventories every nonterminal queue status without snapshots or secrets', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await inventoryLocalPublishQueue({ query } as never);
    const [text, values] = query.mock.calls[0];
    expect(text).toContain('FROM local_publish_jobs');
    expect(text).not.toContain('snapshot');
    expect(values[0]).toEqual([
      'queued',
      'claimed',
      'staged',
      'submitted',
      'scheduled',
      'operator_attested',
      'verification_pending',
      'verified',
    ]);
  });

  it('adds append-only audit storage and preserves receipts and evidence', () => {
    const migration = readFileSync(
      path.join(process.cwd(), 'migrations/024_local_publish_queue_quarantine.sql'),
      'utf8',
    );
    expect(migration).toContain('local_publish_queue_quarantine_items');
    expect(migration).toContain('append-only');
    expect(migration).not.toMatch(/\bDELETE FROM\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\s+TABLE\b/i);
    expect(migration).toContain('BEFORE TRUNCATE');
    expect(migration).not.toMatch(/DROP TABLE/i);
  });
});

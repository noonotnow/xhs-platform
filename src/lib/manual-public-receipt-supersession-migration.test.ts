import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('manual public receipt supersession migration', () => {
  it('adds immutable audit links without changing worker status vocabulary', () => {
    const sql = readFileSync(
      'migrations/019_manual_public_receipt_supersessions.sql',
      'utf8',
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS manual_public_receipt_supersessions');
    expect(sql).toContain('local_publish_job_id UUID NOT NULL UNIQUE');
    expect(sql).toContain('manual_handling_id UUID NOT NULL UNIQUE');
    expect(sql).toContain('manual_reconciliation_id UUID NOT NULL UNIQUE');
    expect(sql).toContain('notion_page_id TEXT NOT NULL UNIQUE');
    expect(sql).toContain("CHECK (provenance = 'manual')");
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
    expect(sql).not.toContain('ALTER TABLE local_publish_jobs');
  });
});

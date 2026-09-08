import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'migrations/028_legacy_ready_x3_batch_fallback_reclassification.sql',
  ),
  'utf8',
);

describe('legacy Ready x3 batch fallback migration', () => {
  it('accepts only the exact constructor-produced fallback for scheduled batch claims', () => {
    expect(sql).toContain(
      `OLD.late_fallback_policy =
      '{"action":"post_now","maxLateMinutes":30}'::jsonb`,
    );
    expect(sql).toContain("item.dispatch_mode = 'scheduled'");
    expect(sql).not.toContain("OLD.late_fallback_policy->>'action'");
    expect(sql).not.toContain("item.dispatch_mode = 'post_now'");
  });

  it('retains the stale-claim lease and pre-browser evidence barriers', () => {
    for (const guard of [
      'OLD.claim_expires_at <= CURRENT_TIMESTAMP',
      'job.claim_expires_at <= CURRENT_TIMESTAMP',
      'job.staged_at IS NULL',
      'job.dispatch_authorized_at IS NULL',
      'job.dispatched_at IS NULL',
      'job.note_id IS NULL',
      'job.share_url IS NULL',
      "event.event_type = 'execution_started'",
      'FROM rednote_publish_attempt_receipts receipt',
      'FROM rednote_publication_evidence evidence',
    ]) {
      expect(sql).toContain(guard);
    }
  });

  it('publishes an independent readiness marker for migration 028', () => {
    expect(sql).toContain(
      'legacy_ready_x3_batch_fallback_reclassification_guard_revision',
    );
    expect(sql).toContain("SELECT '028'::TEXT");
  });
});

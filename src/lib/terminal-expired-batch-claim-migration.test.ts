import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'migrations/029_terminal_expired_batch_claim_reclassification.sql',
  ),
  'utf8',
);

describe('terminal expired batch claim migration', () => {
  it('accepts only the exact automatic lease-expiry terminal shape', () => {
    for (const guard of [
      "OLD.terminal_outcome = 'known_failed'",
      "OLD.receipt_lookup_state = 'not_required'",
      'OLD.claim_expires_at = OLD.terminal_at',
      "job.error_code = 'CLAIM_LEASE_EXPIRED'",
      'job.completed_at = OLD.terminal_at',
      "item.state = 'queued'",
      "item.dispatch_mode = 'scheduled'",
      "event.actor_id = 'local_publish_lease_recovery'",
      'event.occurred_at = OLD.terminal_at',
    ]) {
      expect(sql).toContain(guard);
    }
  });

  it('retains exact authorization and pre-browser evidence barriers', () => {
    expect(sql).toContain(
      `OLD.late_fallback_policy =
      '{"action":"post_now","maxLateMinutes":30}'::jsonb`,
    );
    for (const guard of [
      'OLD.worker_run_id IS NULL',
      'OLD.playwright_run_id IS NULL',
      "event.event_type = 'execution_started'",
      'FROM rednote_publish_attempt_receipts receipt',
      'FROM rednote_publication_evidence evidence',
      'FROM manual_reconciliation_requests reconciliation',
      'FROM external_post_reconciliations reconciliation',
      'FROM plan_operator_scheduled_posts operator_post',
    ]) {
      expect(sql).toContain(guard);
    }
  });

  it('publishes an independent readiness marker for migration 029', () => {
    expect(sql).toContain(
      'terminal_expired_batch_claim_reclassification_guard_revision',
    );
    expect(sql).toContain("SELECT '029'::TEXT");
  });
});

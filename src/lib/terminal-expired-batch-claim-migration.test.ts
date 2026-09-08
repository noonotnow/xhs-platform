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
      'job.notion_page_id = OLD.source_notion_page_id',
      'job.completed_at = OLD.terminal_at',
      "item.state = 'queued'",
      "item.dispatch_mode = 'scheduled'",
      "item.snapshot->>'notionLastEditedTime' = OLD.payload_revision",
      'item.item_hash =',
      'terminal_expired_batch_claim_digest(item.snapshot)',
      "OLD.frozen_payload->>'sourceNotionPageId'",
      "OLD.frozen_payload->>'sourceLocalPublishJobId'",
      "OLD.frozen_payload->>'payloadRevision' = OLD.payload_revision",
      "OLD.frozen_payload->>'payloadDigest' = OLD.payload_digest",
      "OLD.frozen_payload->'browserPayload'",
      'terminal_expired_batch_claim_manifest_digest',
      'OLD.receipt_lookup_updated_at = OLD.terminal_at',
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
      'FROM local_publish_job_success_attestations attestation',
      'FROM local_publish_job_success_attestation_release_acks acknowledgement',
      'FROM manual_reconciliation_requests reconciliation',
      'FROM external_post_reconciliations reconciliation',
      'FROM plan_operator_scheduled_posts operator_post',
      'FROM rednote_publish_job_recoveries recovery',
      'FROM local_publish_queue_quarantine_items quarantine',
      'FROM rednote_publish_attempts sibling_attempt',
    ]) {
      expect(sql).toContain(guard);
    }
    expect(sql).toContain('guard_terminal_expired_batch_claim_reset');
    expect(sql).toContain(
      'terminal expired batch claim reset requires exact authorization reclassification',
    );
  });

  it('publishes an independent readiness marker for migration 029', () => {
    expect(sql).toContain(
      'terminal_expired_batch_claim_reclassification_guard_revision',
    );
    expect(sql).toContain("SELECT '029'::TEXT");
  });
});

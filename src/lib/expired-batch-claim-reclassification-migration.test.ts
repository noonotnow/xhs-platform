import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('expired batch claim reclassification migration', () => {
  const migration = readFileSync(
    join(process.cwd(), 'migrations/027_expired_batch_claim_reclassification.sql'),
    'utf8',
  );

  it('keeps the failed-result guard and adds a separate expired-claim guard', () => {
    expect(migration).toContain(
      "current_setting('app.batch_authorization_reclassification', true) = 'on'",
    );
    expect(migration).toContain(
      "current_setting('app.expired_batch_claim_reclassification', true) = 'on'",
    );
    expect(migration).toContain('AND NOT batch_reclassification');
    expect(migration).toContain('AND NOT expired_claim_reclassification');
  });

  it('requires exact stale claim state and every no-execution evidence barrier', () => {
    for (const guard of [
      "job.status = 'claimed'",
      'job.claim_token = OLD.claim_token',
      'job.claim_expires_at = OLD.claim_expires_at',
      'job.claim_expires_at <= CURRENT_TIMESTAMP',
      'job.staged_at IS NULL',
      'job.dispatch_authorized_at IS NULL',
      'job.dispatched_at IS NULL',
      'job.note_id IS NULL',
      'job.share_url IS NULL',
      'job.success_attestation_id IS NULL',
      'job.external_disposition_request_id IS NULL',
      "item.state = 'claimed'",
      "OLD.authorization_kind = 'ready_x3'",
      'OLD.active',
      'OLD.terminal_outcome IS NULL',
      "OLD.receipt_lookup_state = 'pending'",
      "event.event_type = 'worker_claimed'",
      "event.event_type = 'execution_started'",
      'FROM rednote_publish_attempt_receipts receipt',
      'FROM rednote_publication_evidence evidence',
    ]) {
      expect(migration).toContain(guard);
    }
  });
});

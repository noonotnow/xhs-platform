import { describe, expect, it } from 'vitest';
import {
  assertCanonicalPropertyWrite,
  assertNewAttemptForRetry,
  assertPublishedInvariant,
  hasAtomicPublishedIdentity,
  readCanonicalNextAction,
  REDNOTE_CANONICAL_PROPERTIES,
  REDNOTE_NEXT_ACTIONS,
  REDNOTE_POST_STATUSES,
  REDNOTE_PUBLISH_EXECUTIONS,
  REDNOTE_TERMINAL_ATTEMPT_OUTCOMES,
  REDNOTE_TRANSACTION_REQUESTERS,
  shouldClearActiveAttempt,
  workerAttemptMayRemainActive,
} from '@/lib/rednote-publishing-contract-v1';

describe('rednote publishing contract v1', () => {
  it('freezes the exact canonical enum values and property names', () => {
    expect(REDNOTE_POST_STATUSES).toEqual([
      'Not started', 'Draft', 'In progress', 'Ready', 'Published',
    ]);
    expect(REDNOTE_NEXT_ACTIONS).toEqual([
      'Develop packet', 'Ready for publication', 'Resolve attempt',
      'Backfill receipt', 'Backfill metrics', 'Reconciled', 'Blocked',
    ]);
    expect(REDNOTE_PUBLISH_EXECUTIONS).toEqual([
      'Not attempted', 'Worker claimed', 'Worker batched',
      'Worker batch failed', 'Operator scheduled',
    ]);
    expect(REDNOTE_TERMINAL_ATTEMPT_OUTCOMES).toEqual([
      'accepted', 'known_failed', 'outcome_unknown',
    ]);
    expect(REDNOTE_TRANSACTION_REQUESTERS).toEqual([
      'create', 'plan', 'admin',
    ]);
    expect(REDNOTE_CANONICAL_PROPERTIES.activeAttemptId)
      .toBe('Active XHS attempt ID');
    expect(REDNOTE_CANONICAL_PROPERTIES.platformPublishTime)
      .toBe('Platform publish time');
    expect(Object.values(REDNOTE_CANONICAL_PROPERTIES))
      .not.toContain('Last attempt');
  });

  it('reads legacy receipt aliases but rejects them for canonical writes', () => {
    expect(readCanonicalNextAction('Backfill metadata')).toBe('Backfill receipt');
    expect(readCanonicalNextAction('Backfill URL/metrics')).toBe('Backfill receipt');
    expect(() => assertCanonicalPropertyWrite(
      REDNOTE_CANONICAL_PROPERTIES.nextAction,
      'Backfill metadata',
    )).toThrow(/read-only legacy alias/);
    expect(() => assertCanonicalPropertyWrite(
      REDNOTE_CANONICAL_PROPERTIES.nextAction,
      'Backfill URL\/metrics',
    )).toThrow(/read-only legacy alias/);
    expect(() => assertCanonicalPropertyWrite(
      REDNOTE_CANONICAL_PROPERTIES.nextAction,
      'No action',
    )).toThrow(/not a canonical Next action/);
  });

  it('represents Published identity atomically', () => {
    expect(hasAtomicPublishedIdentity({
      rednoteUrl: 'https://www.rednote.com/explore/note-1',
      rednoteNoteId: 'note-1',
    })).toBe(true);
    expect(hasAtomicPublishedIdentity({ rednoteUrl: 'url-only' })).toBe(false);
    expect(() => assertPublishedInvariant({
      status: 'Published',
      rednoteUrl: null,
      rednoteNoteId: null,
    })).toThrow(/requires Rednote URL and Rednote Note ID atomically/);
  });

  it('keeps only unresolved worker-originated work active', () => {
    expect(workerAttemptMayRemainActive({
      executorType: 'worker',
      terminalOutcome: 'accepted',
      receiptLookupState: 'pending',
    })).toBe(true);
    expect(workerAttemptMayRemainActive({
      executorType: 'operator',
      receiptLookupState: 'pending',
    })).toBe(false);
    expect(workerAttemptMayRemainActive({
      executorType: 'worker',
      terminalOutcome: 'known_failed',
      receiptLookupState: 'pending',
    })).toBe(false);
    expect(shouldClearActiveAttempt({ operatorSupersession: true })).toBe(true);
    expect(shouldClearActiveAttempt({ receiptCaptured: true })).toBe(true);
  });

  it('requires intentional retry to use a new attempt ID', () => {
    expect(() => assertNewAttemptForRetry({
      previousAttemptId: 'attempt-1',
      requestedAttemptId: 'attempt-1',
    })).toThrow(/new attempt ID/);
    expect(() => assertNewAttemptForRetry({
      previousAttemptId: 'attempt-1',
      requestedAttemptId: 'attempt-2',
    })).not.toThrow();
  });
});

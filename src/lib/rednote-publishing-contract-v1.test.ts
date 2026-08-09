import { describe, expect, it } from 'vitest';
import {
  assertCanonicalNextActionWrite,
  assertCanonicalPublishExecutionWrite,
  assertCanonicalPublicationNextStepWrite,
  assertCanonicalPublicationStatusWrite,
  assertCanonicalStatusWrite,
  assertNewAttemptForRetry,
  assertPublishedInvariant,
  type FrozenRednoteAttemptPayload,
  type FrozenRednoteBrowserPayload,
  hasAtomicPublishedIdentity,
  isAttemptResultCurrent,
  REDNOTE_CANONICAL_PROPERTIES,
  REDNOTE_EXECUTOR_KINDS,
  REDNOTE_NEXT_ACTIONS,
  REDNOTE_POST_STATUSES,
  REDNOTE_PUBLICATION_NEXT_STEPS,
  REDNOTE_PUBLICATION_STATUSES,
  REDNOTE_PUBLISH_EXECUTIONS,
  REDNOTE_TERMINAL_ATTEMPT_OUTCOMES,
  REDNOTE_TRANSACTION_REQUESTERS,
  resolveNextActionRead,
  shouldClearActiveAttempt,
  toRednoteBrowserExecutionPayload,
  workerAttemptMayRemainActive,
} from '@/lib/rednote-publishing-contract-v1';

const browserPayload = {
  sourcePostId: 'notion-page-1',
  title: 'Canonical title',
  caption: 'Exact final Caption',
  tags: ['FirstTag', 'SecondTag'],
  scheduledDate: '2026-08-08T12:00:00-04:00',
  targetPublishAt: '2026-08-08T16:00:00.000Z',
  timingMode: 'scheduled',
  visibility: 'public',
  publishMode: 'video',
  mediaAssets: [{
    assetId: 'asset-video-1',
    deliveryUrl: 'https://images.xhs.justlikekatie.com/video.mp4',
    sha256: 'a'.repeat(64),
    mediaType: 'video',
    role: 'content',
  }],
  coverAsset: {
    assetId: 'asset-cover-1',
    deliveryUrl: 'https://images.xhs.justlikekatie.com/cover.jpg',
    sha256: 'b'.repeat(64),
    mediaType: 'image',
    role: 'cover',
  },
} as const satisfies FrozenRednoteBrowserPayload;

const frozenAttempt = {
  contractRevision: 'rednote-publishing/v1',
  sourceNotionPageId: 'notion-page-1',
  payloadRevision: 'rednote-browser-payload/v1',
  payloadDigest: 'c'.repeat(64),
  requestedAt: '2026-08-07T16:00:00.000Z',
  executor: {
    type: 'worker',
    kind: 'playwright',
    id: 'xhs-admin-worker',
  },
  browserPayload,
} as const satisfies FrozenRednoteAttemptPayload;

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
    expect(REDNOTE_PUBLICATION_STATUSES).toEqual([
      'Not attempted', 'Worker claimed', 'Worker failed', 'Verify receipt',
      'Backfill metadata', 'Published',
    ]);
    expect(REDNOTE_PUBLICATION_NEXT_STEPS).toEqual([
      'Worker failed', 'Verify receipt', 'Backfill metrics',
    ]);
    expect(REDNOTE_TERMINAL_ATTEMPT_OUTCOMES).toEqual([
      'accepted', 'known_failed', 'outcome_unknown',
    ]);
    expect(REDNOTE_TRANSACTION_REQUESTERS).toEqual([
      'create', 'plan', 'admin',
    ]);
    expect(REDNOTE_EXECUTOR_KINDS).toEqual([
      'playwright', 'microservice', 'operator',
    ]);
    expect(REDNOTE_CANONICAL_PROPERTIES.activeAttemptId)
      .toBe('Active XHS attempt ID');
    expect(REDNOTE_CANONICAL_PROPERTIES.platformPublishTime)
      .toBe('Platform publish time');
    expect(REDNOTE_CANONICAL_PROPERTIES.publicationStatus)
      .toBe('Publication Status');
    expect(REDNOTE_CANONICAL_PROPERTIES.publicationNextStep)
      .toBe('Publication Next Step');
    expect(Object.values(REDNOTE_CANONICAL_PROPERTIES))
      .not.toContain('Last attempt');
  });

  it('classifies legacy aliases from receipt and metrics context and rejects new writes', () => {
    expect(resolveNextActionRead('Backfill metadata', {
      hasReceiptIdentity: false,
      metricsComplete: false,
    })).toEqual({ kind: 'canonical', value: 'Backfill receipt' });
    expect(resolveNextActionRead('Backfill URL/metrics', {
      hasReceiptIdentity: true,
      metricsComplete: false,
    })).toEqual({ kind: 'canonical', value: 'Backfill metrics' });
    expect(resolveNextActionRead('Backfill URL/metrics', {
      hasReceiptIdentity: true,
      metricsComplete: true,
    })).toMatchObject({ kind: 'legacy_classification_required' });
    expect(() => assertCanonicalNextActionWrite(
      'Backfill metadata',
    )).toThrow(/read-only legacy alias/);
    expect(() => assertCanonicalNextActionWrite(
      'Backfill URL\/metrics',
    )).toThrow(/read-only legacy alias/);
    expect(() => assertCanonicalNextActionWrite(
      'No action',
    )).toThrow(/not a canonical Next action/);
    expect(() => assertCanonicalStatusWrite('Queued'))
      .toThrow(/not a canonical Status/);
    expect(() => assertCanonicalPublishExecutionWrite('Retrying'))
      .toThrow(/not a canonical Publish execution/);
    expect(() => assertCanonicalPublicationStatusWrite('Approved'))
      .toThrow(/not a canonical Publication Status/);
    expect(() => assertCanonicalPublicationNextStepWrite('Backfill metadata'))
      .toThrow(/not a canonical Publication Next Step/);
  });

  it('freezes the exact browser-ready payload without seeds or notes substitution', () => {
    expect(toRednoteBrowserExecutionPayload(frozenAttempt))
      .toEqual(browserPayload);
    expect(toRednoteBrowserExecutionPayload(frozenAttempt).caption)
      .toBe('Exact final Caption');
    expect(toRednoteBrowserExecutionPayload(frozenAttempt).mediaAssets)
      .toEqual(browserPayload.mediaAssets);

    const creativeDraftWithoutCaption = {
      ...browserPayload,
      caption: undefined,
      seeds: ['Seed text'],
      notes: 'Editorial notes',
    };
    // @ts-expect-error Seeds and notes cannot satisfy the required Caption field.
    const invalidPayload: FrozenRednoteBrowserPayload = creativeDraftWithoutCaption;
    expect(invalidPayload.caption).toBeUndefined();
  });

  it('represents Published identity atomically', () => {
    expect(hasAtomicPublishedIdentity({
      rednoteUrl: 'https://www.rednote.com/explore/note-1',
      rednoteNoteId: 'note-1',
    })).toBe(true);
    expect(hasAtomicPublishedIdentity({ rednoteUrl: 'url-only' })).toBe(false);
    expect(() => assertPublishedInvariant({
      publicationStatus: 'Published',
      rednoteUrl: null,
      rednoteNoteId: null,
    })).toThrow(/requires Rednote URL and Rednote Note ID atomically/);
    expect(() => assertPublishedInvariant({
      publicationStatus: 'Published',
      rednoteUrl: 'https://www.rednote.com/explore/note-1',
      rednoteNoteId: 'note-1',
    })).not.toThrow();
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
    expect(isAttemptResultCurrent({
      resultAttemptId: 'attempt-1',
      activeAttemptId: 'attempt-2',
    })).toBe(false);
    expect(isAttemptResultCurrent({
      resultAttemptId: 'attempt-1',
      activeAttemptId: 'attempt-1',
      supersededByAttemptId: 'attempt-2',
    })).toBe(false);
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

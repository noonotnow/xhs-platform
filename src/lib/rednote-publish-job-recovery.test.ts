import { describe, expect, it } from 'vitest';
import {
  parseRednotePublishJobRecoveryInput,
  validateRecoveryCandidate,
  type RecoveryCandidateState,
  type RednotePublishJobRecoveryInput,
} from '@/lib/rednote-publish-job-recovery';
import type { LocalPublishSnapshot } from '@/types/local-publish-job';

const batchId = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const manifestHash = 'a'.repeat(64);
const itemHash = 'b'.repeat(64);
const snapshotRevision = '2026-08-04T13:12:00.000Z';
const actor = 'operator@example.com';

const snapshot: LocalPublishSnapshot = {
  notionPageId: '44444444-4444-4444-8444-444444444444',
  headline: 'Approved post',
  title: 'Approved post',
  caption: 'Frozen caption',
  tags: ['Frozen'],
  platform: 'RedNote',
  mediaType: 'video',
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/post.mp4',
  publishAt: '2026-08-04T18:00:00.000Z',
  notionLastEditedTime: snapshotRevision,
};

const input: RednotePublishJobRecoveryInput = {
  batchId,
  manifestHash,
  itemId,
  jobId,
  itemHash,
  snapshotRevision,
};

function candidate(
  overrides: Partial<RecoveryCandidateState> = {},
): RecoveryCandidateState {
  return {
    batchId,
    batchStatus: 'approved',
    manifestHash,
    approvedAt: '2026-08-04T17:03:59.881Z',
    itemId,
    itemBatchId: batchId,
    itemHash,
    itemState: 'failed',
    itemLocalPublishJobId: jobId,
    itemSnapshot: snapshot,
    jobId,
    jobBatchItemId: itemId,
    jobStatus: 'failed',
    jobSnapshot: snapshot,
    jobErrorCode: 'BOUNDED_BATCH_BYPASS_DISABLED',
    jobClaimAttempts: 1,
    jobClaimToken: '55555555-5555-4555-8555-555555555555',
    jobClaimedAt: '2026-08-04T17:04:33.424Z',
    jobClaimExpiresAt: '2026-08-04T19:04:33.424Z',
    jobCompletedAt: '2026-08-04T17:04:33.963Z',
    stagedAt: null,
    dispatchAuthorizedAt: null,
    dispatchedAt: null,
    noteId: null,
    shareUrl: null,
    nextVerificationAt: null,
    verifiedAt: null,
    reconciledAt: null,
    verificationAttempts: 0,
    activeOwnership: false,
    audit: null,
    ...overrides,
  };
}

describe('bounded publish job recovery validation', () => {
  it('accepts only the exact failed approved job and exact queued idempotent retry', () => {
    expect(validateRecoveryCandidate(candidate(), input, actor)).toBe('recover');
    const recovered = candidate({
      itemState: 'queued',
      jobStatus: 'queued',
      jobErrorCode: null,
      jobClaimToken: null,
      jobClaimedAt: null,
      jobClaimExpiresAt: null,
      jobCompletedAt: null,
      audit: {
        id: '66666666-6666-4666-8666-666666666666',
        ...input,
        recoveredBy: actor,
        recoveredAt: '2026-08-04T17:30:00.000Z',
        priorClaimAttempts: 1,
        priorClaimedAt: '2026-08-04T17:04:33.424Z',
        priorCompletedAt: '2026-08-04T17:04:33.963Z',
      },
    });

    expect(validateRecoveryCandidate(recovered, input, actor)).toBe('already_recovered');
    expect(() => validateRecoveryCandidate(
      { ...recovered, jobStatus: 'claimed' },
      input,
      actor,
    )).toThrow(/distinct later terminal/i);
  });

  it('accepts the 8-second active-drain refailure as a distinct generation', () => {
    const refailed = candidate({
      jobClaimAttempts: 2,
      jobClaimedAt: '2026-08-04T17:30:08.000Z',
      jobClaimExpiresAt: '2026-08-04T19:30:08.000Z',
      jobCompletedAt: '2026-08-04T17:30:08.500Z',
      audit: {
        id: '66666666-6666-4666-8666-666666666666',
        ...input,
        recoveredBy: actor,
        recoveredAt: '2026-08-04T17:30:00.000Z',
        priorClaimAttempts: 1,
        priorClaimedAt: '2026-08-04T17:04:33.424Z',
        priorCompletedAt: '2026-08-04T17:04:33.963Z',
      },
    });
    expect(validateRecoveryCandidate(refailed, input, actor)).toBe('recover');
  });

  it.each([
    ['unchanged generation', { jobClaimAttempts: 1 }],
    ['missing later claim', { jobClaimAttempts: 2, jobClaimedAt: null }],
    [
      'claim before latest recovery',
      { jobClaimAttempts: 2, jobClaimedAt: '2026-08-04T17:29:59.000Z' },
    ],
    [
      'completion before claim',
      {
        jobClaimAttempts: 2,
        jobClaimedAt: '2026-08-04T17:30:08.000Z',
        jobCompletedAt: '2026-08-04T17:30:07.000Z',
      },
    ],
  ])('rejects repeat recovery for %s', (_label, overrides) => {
    expect(() => validateRecoveryCandidate(candidate(Object.assign({
      jobClaimAttempts: 2,
      jobClaimedAt: '2026-08-04T17:30:08.000Z',
      jobCompletedAt: '2026-08-04T17:30:08.500Z',
      audit: {
        id: '66666666-6666-4666-8666-666666666666',
        ...input,
        recoveredBy: actor,
        recoveredAt: '2026-08-04T17:30:00.000Z',
        priorClaimAttempts: 1,
        priorClaimedAt: '2026-08-04T17:04:33.424Z',
        priorCompletedAt: '2026-08-04T17:04:33.963Z',
      },
    }, overrides)), input, actor)).toThrow(/distinct later terminal/i);
  });

  it.each([
    ['staged_at', { stagedAt: '2026-08-04T17:05:00.000Z' }],
    ['dispatch authorization', { dispatchAuthorizedAt: '2026-08-04T17:05:00.000Z' }],
    ['dispatch', { dispatchedAt: '2026-08-04T17:05:00.000Z' }],
    ['note id', { noteId: 'note-1' }],
    ['share URL', { shareUrl: 'https://www.rednote.com/explore/note-1' }],
    ['verification due time', { nextVerificationAt: '2026-08-04T18:00:00.000Z' }],
    ['verification attempts', { verificationAttempts: 1 }],
    ['verified timestamp', { verifiedAt: '2026-08-04T18:00:00.000Z' }],
    ['reconciled timestamp', { reconciledAt: '2026-08-04T18:00:00.000Z' }],
  ])('rejects %s evidence', (_label, overrides) => {
    expect(() => validateRecoveryCandidate(candidate(overrides), input, actor))
      .toThrow(/staging, dispatch, publication, or verification evidence/i);
  });

  it.each([
    ['wrong manifest', { manifestHash: 'c'.repeat(64) }, {}],
    ['wrong item', { itemId: '77777777-7777-4777-8777-777777777777' }, {}],
    ['wrong job', { jobId: '77777777-7777-4777-8777-777777777777' }, {}],
    ['wrong item hash', { itemHash: 'c'.repeat(64) }, {}],
    [
      'wrong revision',
      { snapshotRevision: '2026-08-04T13:13:00.000Z' },
      {},
    ],
    ['changed item linkage', {}, { itemLocalPublishJobId: null }],
    ['changed job linkage', {}, { jobBatchItemId: null }],
    [
      'changed immutable snapshot',
      {},
      { jobSnapshot: { ...snapshot, caption: 'Changed' } },
    ],
  ])('rejects %s', (_label, inputOverride, stateOverride) => {
    expect(() => validateRecoveryCandidate(
      candidate(stateOverride),
      { ...input, ...inputOverride },
      actor,
    )).toThrow(/identifiers, hashes, linkage, or immutable snapshots/i);
  });

  it.each(['pending_approval', 'partially_approved', 'superseded'])(
    'rejects a %s batch',
    (batchStatus) => {
      expect(() => validateRecoveryCandidate(
        candidate({ batchStatus }),
        input,
        actor,
      )).toThrow(/not still exactly approved/i);
    },
  );

  it('rejects missing approval, wrong error, and active alternate ownership', () => {
    expect(() => validateRecoveryCandidate(
      candidate({ approvedAt: null }),
      input,
      actor,
    )).toThrow(/not still exactly approved/i);
    expect(() => validateRecoveryCandidate(
      candidate({ jobErrorCode: 'STAGING_FAILED' }),
      input,
      actor,
    )).toThrow(/only the exact terminal bypass-disabled failure/i);
    expect(() => validateRecoveryCandidate(
      candidate({ itemState: 'queued' }),
      input,
      actor,
    )).toThrow(/only the exact terminal bypass-disabled failure/i);
    expect(() => validateRecoveryCandidate(
      candidate({ jobStatus: 'claimed' }),
      input,
      actor,
    )).toThrow(/only the exact terminal bypass-disabled failure/i);
    expect(() => validateRecoveryCandidate(
      candidate({ jobCompletedAt: null }),
      input,
      actor,
    )).toThrow(/only the exact terminal bypass-disabled failure/i);
    expect(() => validateRecoveryCandidate(
      candidate({ activeOwnership: true }),
      input,
      actor,
    )).toThrow(/another publish or reconciliation lifecycle/i);
  });

  it('requires confirmed exact canonical evidence at the API boundary', () => {
    expect(parseRednotePublishJobRecoveryInput({
      ...input,
      confirmed: true,
    })).toEqual(input);
    expect(() => parseRednotePublishJobRecoveryInput({
      ...input,
      confirmed: false,
    })).toThrow(/confirmation/i);
    expect(() => parseRednotePublishJobRecoveryInput({
      ...input,
      confirmed: true,
      priorErrorCode: 'BOUNDED_BATCH_BYPASS_DISABLED',
    })).toThrow(/unsupported or missing fields/i);
    expect(() => parseRednotePublishJobRecoveryInput({
      ...input,
      snapshotRevision: '2026-08-04T13:12:00Z',
      confirmed: true,
    })).toThrow(/canonical UTC timestamp/i);
  });
});

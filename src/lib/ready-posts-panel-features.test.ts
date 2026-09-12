import { describe, expect, it } from 'vitest';
import {
  READY_POSTS_PANEL_FEATURES,
  readyPostMediaPreview,
  readyPostRecoveryAction,
  requestedReadyPostIsMissing,
  resolveReadyPostSelection,
} from '@/lib/ready-posts-panel-features';
import {
  BROWSER_CLOSED_PRE_PUBLISH_CONFIRMATION,
} from '@/lib/rednote-publish-job-recovery-contract';
import type {
  RednotePublishJobRecoveryEvidence,
} from '@/types/local-publish-job';

describe('Ready posts panel feature visibility', () => {
  it('opens the matching Notion record from a browser-safe deep link', () => {
    const posts = [{ id: 'first' }, { id: 'matching-notion-page' }];

    expect(resolveReadyPostSelection(posts, 'first', 'matching-notion-page'))
      .toBe('matching-notion-page');
    expect(resolveReadyPostSelection(posts, 'first', 'missing')).toBe('first');
    expect(resolveReadyPostSelection(posts, '', 'missing')).toBe('first');
  });

  it('reports a missing requested handoff without changing fallback selection', () => {
    const posts = [{ id: 'first' }, { id: 'second' }];

    expect(requestedReadyPostIsMissing(posts, 'missing-browser-safe-id')).toBe(true);
    expect(requestedReadyPostIsMissing(posts, 'second')).toBe(false);
    expect(requestedReadyPostIsMissing(posts)).toBe(false);
    expect(resolveReadyPostSelection(posts, 'second', 'missing-browser-safe-id'))
      .toBe('second');
  });

  it('shows bounded batch approval without restoring legacy execution audits', () => {
    expect(READY_POSTS_PANEL_FEATURES).toEqual({
      boundedBatchApproval: true,
      legacyExecutionAudits: false,
    });
  });

  it('hides placeholder media before it can reach next/image', () => {
    expect(readyPostMediaPreview({
      candidateKind: 'packet_ready',
      compatibilityTrialVideoUrls: [],
      imageUrls: [
        'https://example.com/image.jpg',
        'https://images.xhs.justlikekatie.com/uploads/valid.jpg',
      ],
      thumbnailUrl: 'https://example.com/image.jpg',
      videoUrls: [],
    })).toEqual({
      choices: [{
        type: 'image',
        index: 1,
        url: 'https://images.xhs.justlikekatie.com/uploads/valid.jpg',
      }],
      rejectedUrls: ['https://example.com/image.jpg'],
      thumbnailUrl: undefined,
    });
  });

  it('uses a distinct confirmation and copy for browser-closed recovery', () => {
    const evidence: RednotePublishJobRecoveryEvidence = {
      recoveryKind: 'browser_closed_pre_publish',
      batchId: '11111111-1111-4111-8111-111111111111',
      manifestHash: 'a'.repeat(64),
      itemId: '22222222-2222-4222-8222-222222222222',
      jobId: '33333333-3333-4333-8333-333333333333',
      itemHash: 'b'.repeat(64),
      snapshotRevision: '2026-08-04T13:12:00.000Z',
      priorErrorCode: 'INTERNAL_ERROR',
      claimAttempts: 1,
    };

    expect(readyPostRecoveryAction(evidence)).toEqual({
      confirmation: BROWSER_CLOSED_PRE_PUBLISH_CONFIRMATION,
      reason: 'Browser closed during approved pre-Publish media loading',
      failureDetail:
        'Recorded failure: the browser closed while loading approved media before Publish.\n',
      idleLabel: 'Confirm browser-closed recovery',
      busyLabel: 'Recovering browser-closed job…',
    });
    expect(readyPostRecoveryAction(
      { ...evidence, recoveryKind: 'standard', priorErrorCode: 'NOT_LOGGED_IN' },
    )).toMatchObject({
      confirmation: true,
      reason: 'Persistent Creator browser profile required login before staging',
      idleLabel: 'Confirm exact-job recovery',
    });
  });
});

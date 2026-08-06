import { describe, expect, it } from 'vitest';
import {
  directManualSchedulingCandidate,
  displayedLocalPublishJob,
  hasLiveUnsafeAutomationOwnership,
  isActiveLocalPublishJob,
  publicationOperationalTruth,
  receiptPendingLocalPublishJobs,
} from '@/lib/local-publish-job-display';
import type {
  LocalPublishJobSummary,
  PublishBatch,
} from '@/types/local-publish-job';
import type { ReadyXhsPost } from '@/types/ready-post';

function job(
  id: string,
  status: LocalPublishJobSummary['status'],
): LocalPublishJobSummary {
  return {
    id,
    notionPageId: 'post',
    status,
    createdAt: '2026-08-03T12:00:00.000Z',
    updatedAt: '2026-08-03T12:00:00.000Z',
    verificationAttempts: 0,
  };
}

describe('local publish job display selection', () => {
  it('does not let a terminal failed attempt hide an older active job', () => {
    const failed = job('failed', 'failed');
    const active = job('active', 'claimed');
    expect(displayedLocalPublishJob([failed, active], 'post')).toBe(active);
    expect(isActiveLocalPublishJob(active)).toBe(true);
  });

  it('leaves a terminal failed attempt retryable when no active job exists', () => {
    const failed = job('failed', 'failed');
    expect(displayedLocalPublishJob([failed], 'post')).toBe(failed);
    expect(isActiveLocalPublishJob(failed)).toBe(false);
  });

  it('keeps operator-attested receipt-pending jobs visible outside ready-post filtering', () => {
    const attested = job('attested', 'operator_attested');
    const reconciled = job('reconciled', 'reconciled');

    expect(receiptPendingLocalPublishJobs([reconciled, attested])).toEqual([attested]);
  });

  it('lets manual truth supersede queued and expired staged work, but not a live permit', () => {
    expect(hasLiveUnsafeAutomationOwnership(job('queued', 'queued'))).toBe(false);
    expect(hasLiveUnsafeAutomationOwnership({
      ...job('stale', 'staged'),
      claimExpiresAt: '2026-01-01T00:00:00.000Z',
    }, Date.parse('2026-08-06T12:00:00.000Z'))).toBe(false);
    expect(hasLiveUnsafeAutomationOwnership({
      ...job('authorized', 'staged'),
      claimExpiresAt: '2026-01-01T00:00:00.000Z',
      dispatchAuthorizedAt: '2026-01-01T00:00:00.000Z',
    }, Date.parse('2026-08-06T12:00:00.000Z'))).toBe(true);
  });

  it('keeps Day 5 immutable attestation truth ahead of a newer terminal attempt', () => {
    const attested = {
      ...job('a682cbdd-8392-4757-87b3-adb2ae729cfb', 'operator_attested'),
      notionPageId: 'ff813547-96bc-472c-8ec4-c4bcc9c058c0',
      successAttestation: {
        id: '7aa87031-464a-4daf-8eea-2246bcb908af',
        notionPageId: 'ff813547-96bc-472c-8ec4-c4bcc9c058c0',
        provenance: 'worker_ambiguous' as const,
        contractRevision: 'operator-success-attestation/v1' as const,
        batchId: 'c05ef8d9-f4a0-4d5e-b75d-a99367ec8305',
        manifestHash: 'a'.repeat(64),
        itemId: '51c75c66-39af-4126-9a1f-deaf901f7053',
        jobId: 'a682cbdd-8392-4757-87b3-adb2ae729cfb',
        itemHash: 'b'.repeat(64),
        snapshotRevision: '2026-08-05T21:28:00.000Z',
        snapshotDigest: 'b'.repeat(64),
        releaseRequired: false,
        requestedPublishAt: '2026-08-06T14:30:00.000Z',
        expectedOutcome: {
          kind: 'scheduled' as const,
          publishAt: '2026-08-06T14:30:00.000Z',
          timeZone: 'America/New_York' as const,
          text: 'Successfully scheduled',
        },
        attestedBy: 'operator@example.com',
        attestedAt: '2026-08-06T12:00:00.000Z',
      },
    };
    const failed = {
      ...job('newer-failed', 'failed'),
      notionPageId: attested.notionPageId,
    };
    const selected = displayedLocalPublishJob([failed, attested], attested.notionPageId);
    expect(selected).toBe(attested);
    expect(publicationOperationalTruth(
      readyPost({ id: attested.notionPageId }),
      selected,
      undefined,
    )).toEqual({
      state: 'attested_verification_pending',
      label: 'Attested · verification pending',
    });
  });

  it('surfaces manually published Song Weilong as attested pending verification', () => {
    const post = readyPost({
      id: '99b1d82f-ecc7-4086-ad1a-a53e3ed71de4',
      headline: '《七根心简》之后：宋威龙氛围格子',
    });
    const queued = {
      ...job('11ff829f-e844-4ade-ba59-959cbcbdbd60', 'queued'),
      notionPageId: post.id,
    };
    expect(publicationOperationalTruth(post, queued, {
      id: 'reconciliation',
      notionPageId: post.id,
      kind: 'notion_only',
      sourceLocalJobId: queued.id,
      noteId: 'note',
      shareUrl: 'https://www.rednote.com/explore/note',
      status: 'queued',
      verificationAttempts: 0,
      createdAt: '2026-08-06T12:00:00.000Z',
      updatedAt: '2026-08-06T12:00:00.000Z',
    })).toEqual({
      state: 'attested_verification_pending',
      label: 'Attested · verification pending',
    });
  });

  it('distinguishes published, provenance-review, and genuinely unpublished truth', () => {
    const post = readyPost();
    expect(publicationOperationalTruth(
      { ...post, status: 'Published' },
      undefined,
      undefined,
    )).toEqual({ state: 'published', label: 'Published' });
    expect(publicationOperationalTruth(
      post,
      job('queued', 'queued'),
      undefined,
    )).toEqual({ state: 'not_published', label: 'Not published' });

    const manualAttested = {
      ...job('manual-attested', 'operator_attested'),
      successAttestation: {
        id: 'attestation',
        notionPageId: post.id,
        provenance: 'manual_scheduled' as const,
        contractRevision: 'manual-scheduling-attestation/v1' as const,
        batchId: 'batch',
        manifestHash: 'a'.repeat(64),
        itemId: 'item',
        jobId: 'manual-attested',
        itemHash: 'b'.repeat(64),
        snapshotRevision: post.lastEditedTime,
        snapshotDigest: 'b'.repeat(64),
        releaseRequired: false,
        requestedPublishAt: post.publishAt!,
        expectedOutcome: {
          kind: 'scheduled' as const,
          publishAt: post.publishAt!,
          timeZone: 'America/New_York' as const,
          text: 'Successfully scheduled',
        },
        attestedBy: 'operator@example.com',
        attestedAt: '2026-08-06T12:00:00.000Z',
      },
    };
    expect(publicationOperationalTruth(post, manualAttested, undefined)).toEqual({
      state: 'scheduled_receipt_pending',
      label: 'Scheduled · receipt pending',
    });
    expect(publicationOperationalTruth(
      { ...post, lastEditedTime: '2026-08-06T12:01:00.000Z' },
      manualAttested,
      undefined,
    )).toEqual({
      state: 'provenance_mismatch',
      label: 'Scheduled · provenance mismatch · needs review',
    });
  });

  it('offers direct manual scheduling from the exact queued batch item', () => {
    const post = readyPost({
      id: 'd5aeaf77-a28e-4786-970a-6816a99f694f',
      headline: 'How to read a Vibe Atlas grid｜怎么看氛围格子',
      scheduledDate: '2026-08-06T03:00:00.000Z',
      publishAt: '2026-08-06T03:00:00.000Z',
    });
    const queued = {
      ...job('82c99063-ee5f-40ff-9da5-7f5051350156', 'queued'),
      notionPageId: post.id,
    };
    const batch: PublishBatch = {
      id: 'batch',
      kind: 'bootstrap',
      status: 'approved',
      manifestHash: 'a'.repeat(64),
      createdAt: '2026-08-06T00:00:00.000Z',
      approvedAt: '2026-08-06T00:01:00.000Z',
      items: [{
        id: 'item',
        notionPageId: post.id,
        snapshot: {
          notionPageId: post.id,
          headline: post.headline,
          title: post.headline,
          caption: post.caption,
          tags: post.tags,
          platform: 'RedNote',
          mediaType: 'image',
          mediaIndex: 0,
          mediaUrl: post.imageUrls[0],
          publishAt: post.publishAt,
          notionLastEditedTime: post.lastEditedTime,
        },
        itemHash: 'b'.repeat(64),
        state: 'queued',
        dispatchMode: 'scheduled',
        lateBySeconds: 0,
        localPublishJobId: queued.id,
      }],
      blockedCandidates: [],
    };
    expect(directManualSchedulingCandidate(
      post,
      [batch],
      [job('unrelated-attested', 'operator_attested'), queued],
    )).toEqual(expect.objectContaining({
      batchId: batch.id,
      itemId: 'item',
      requestedPublishAt: post.publishAt,
    }));
  });
});

function readyPost(overrides: Partial<ReadyXhsPost> = {}): ReadyXhsPost {
  return {
    id: 'post',
    pageUrl: 'https://notion.so/post',
    headline: 'Post',
    caption: 'Caption',
    status: 'Ready',
    publishPacketReady: true,
    hasVideo: false,
    needsMedia: false,
    needsCaption: false,
    mediaUrls: ['https://images.xhs.justlikekatie.com/post.png'],
    imageUrls: ['https://images.xhs.justlikekatie.com/post.png'],
    videoUrls: [],
    thumbnailUrl: '',
    tags: ['tag'],
    scheduledDate: '2026-08-06T14:30:00.000Z',
    publishAt: '2026-08-06T14:30:00.000Z',
    lastEditedTime: '2026-08-05T21:28:00.000Z',
    publishBlockers: [],
    candidateKind: 'packet_ready',
    ...overrides,
    automationBlockers: overrides.automationBlockers ?? [],
    manualWarnings: overrides.manualWarnings ?? [],
  };
}

import { describe, expect, it } from 'vitest';
import {
  displayedLocalPublishJob,
  isActiveLocalPublishJob,
  receiptPendingLocalPublishJobs,
} from '@/lib/local-publish-job-display';
import type { LocalPublishJobSummary } from '@/types/local-publish-job';

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
});

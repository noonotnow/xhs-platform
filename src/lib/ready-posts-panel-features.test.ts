import { describe, expect, it } from 'vitest';
import { READY_POSTS_PANEL_FEATURES } from '@/lib/ready-posts-panel-features';

describe('Ready posts panel feature visibility', () => {
  it('shows bounded batch approval without restoring legacy execution audits', () => {
    expect(READY_POSTS_PANEL_FEATURES).toEqual({
      boundedBatchApproval: true,
      legacyExecutionAudits: false,
    });
  });
});

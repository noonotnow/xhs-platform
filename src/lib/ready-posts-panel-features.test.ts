import { describe, expect, it } from 'vitest';
import {
  READY_POSTS_PANEL_FEATURES,
  readyPostMediaPreview,
} from '@/lib/ready-posts-panel-features';

describe('Ready posts panel feature visibility', () => {
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
});

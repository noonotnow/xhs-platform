import { createHash } from 'crypto';
import type { LocalPublishMediaType } from '@/types/local-publish-job';

export function rednoteMediaIdentity(media: {
  type: LocalPublishMediaType;
  url: string;
}) {
  return createHash('sha256')
    .update(JSON.stringify({ type: media.type, url: media.url }))
    .digest('hex');
}

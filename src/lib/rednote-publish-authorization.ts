import { createHash } from 'crypto';
import type {
  LocalPublishMediaType,
  LocalPublishSnapshot,
  PublishMedia,
} from '@/types/local-publish-job';

export function rednoteMediaIdentity(media: {
  type: LocalPublishMediaType;
  url: string;
}) {
  return createHash('sha256')
    .update(JSON.stringify({ type: media.type, url: media.url }))
    .digest('hex');
}

export function rednotePublishMedia(
  type: LocalPublishMediaType,
  url: string,
): PublishMedia {
  return { identity: rednoteMediaIdentity({ type, url }), type, url };
}

export function snapshotPublishMedia(
  snapshot: Pick<LocalPublishSnapshot, 'media' | 'mediaType' | 'mediaUrl'>,
): PublishMedia[] {
  const media = snapshot.media ?? [
    rednotePublishMedia(snapshot.mediaType, snapshot.mediaUrl),
  ];
  if (
    media.length < 1
    || media.length > 18
    || media[0]?.type !== snapshot.mediaType
    || media[0]?.url !== snapshot.mediaUrl
    || media.some((item) => (
      item.type !== snapshot.mediaType
      || item.identity !== rednoteMediaIdentity(item)
    ))
  ) {
    throw new Error('Stored media does not match its immutable ordered projection');
  }
  return [...media];
}

export const REDNOTE_CREATOR_PUBLISH_URL =
  'https://creator.rednote.com/publish/publish';

export const SAFE_EXTERNAL_LINK_PROPS = {
  target: '_blank',
  rel: 'noopener noreferrer',
} as const;

export const PREPARED_HANDOFF_FRESHNESS_MS = 2 * 60 * 1000;

interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export interface CopyHandoffResult {
  ok: boolean;
  message: string;
}

export interface FileShareCapability {
  canShare?: (data: ShareData) => boolean;
}

export function canSharePreparedPacket(
  navigatorLike: FileShareCapability,
  shareData: ShareData,
) {
  return Boolean(
    navigatorLike.canShare
    && navigatorLike.canShare(shareData),
  );
}

export function isPreparedHandoffFresh(
  validatedAt: number,
  now = Date.now(),
) {
  return Number.isFinite(validatedAt)
    && validatedAt <= now
    && now - validatedAt < PREPARED_HANDOFF_FRESHNESS_MS;
}

export interface ManualHandoffEligibility {
  destination: string;
  studioStatus: string;
  publishPacketReady: boolean;
  readinessBlockers: readonly string[];
  workspace: {
    requestedId: string;
    packetId: string;
  };
  postId: string;
  sourceRevision: string;
  packet: {
    identity: string;
    postId: string;
    sourceRevision: string;
    mediaIdentities: readonly string[];
    expectedMediaIdentities: readonly string[];
  };
  attempt: {
    identity: string;
    sourceLocalPublishJobId: string;
    payloadDigest: string;
    payloadRevision: string;
    eligible: boolean;
  };
  localPublishJobId: string;
}

export function isManualHandoffEligible(
  value: ManualHandoffEligibility,
) {
  const status = value.studioStatus.trim().toLowerCase();
  return value.destination.trim().toLowerCase() === 'rednote'
    && (status === 'ready' || status === 'approved')
    && value.publishPacketReady
    && value.readinessBlockers.length === 0
    && Boolean(value.workspace.requestedId.trim())
    && value.workspace.packetId === value.workspace.requestedId
    && Boolean(value.postId.trim())
    && Boolean(value.sourceRevision.trim())
    && Boolean(value.packet.identity.trim())
    && value.packet.postId === value.postId
    && value.packet.sourceRevision === value.sourceRevision
    && value.packet.mediaIdentities.length > 0
    && value.packet.mediaIdentities.every((identity) => Boolean(identity.trim()))
    && value.packet.mediaIdentities.length === value.packet.expectedMediaIdentities.length
    && value.packet.mediaIdentities.every(
      (identity, index) => identity === value.packet.expectedMediaIdentities[index],
    )
    && Boolean(value.attempt.identity.trim())
    && value.attempt.sourceLocalPublishJobId === value.localPublishJobId
    && Boolean(value.attempt.payloadDigest.trim())
    && Boolean(value.attempt.payloadRevision.trim())
    && value.attempt.eligible;
}

export async function copyHandoffText(
  clipboard: ClipboardWriter | undefined,
  value: string,
  label: string,
): Promise<CopyHandoffResult> {
  if (!value.trim()) {
    return { ok: false, message: `${label} is empty.` };
  }
  if (!clipboard?.writeText) {
    return {
      ok: false,
      message: `Clipboard access is unavailable. Select and copy the ${label.toLowerCase()} manually.`,
    };
  }

  try {
    await clipboard.writeText(value);
    return { ok: true, message: `${label} copied.` };
  } catch {
    return {
      ok: false,
      message: `Could not copy the ${label.toLowerCase()}. Select it and copy manually.`,
    };
  }
}

export function getCanonicalVideoUrl(videoUrls: string[]) {
  return videoUrls.find((url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' &&
        parsed.hostname === 'images.xhs.justlikekatie.com' &&
        parsed.pathname.startsWith('/videos/assets/') &&
        parsed.pathname.toLowerCase().endsWith('.mp4');
    } catch {
      return false;
    }
  });
}

function filenamePart(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\u00C0-\uFFFF\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

export function getVideoDownloadName(headline: string, videoUrl: string) {
  let sourceName = '';
  try {
    sourceName = decodeURIComponent(new URL(videoUrl).pathname)
      .split('/')
      .pop()
      ?.replace(/\.mp4$/i, '') ?? '';
  } catch {
    sourceName = '';
  }
  return `${filenamePart(headline) || filenamePart(sourceName) || 'rednote-video'}.mp4`;
}

export function shouldOfferTitleCopy(headline: string, caption: string) {
  const title = headline.trim().toLocaleLowerCase();
  const body = caption.trim().toLocaleLowerCase();
  const firstLine = body.split(/\r?\n/, 1)[0]?.trim();
  return Boolean(title) && body !== title && firstLine !== title;
}

export function getMissingTags(tags: string[], caption: string) {
  const normalizedCaption = caption.toLocaleLowerCase();
  return tags
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter(Boolean)
    .filter((tag) => {
      const escapedTag = tag
        .toLocaleLowerCase()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(
        `(?:^|[#\\s,，])${escapedTag}(?=$|[\\s,，.!?;:、。！？])`,
        'u',
      ).test(normalizedCaption);
    });
}

export function formatTags(tags: string[]) {
  return tags.map((tag) => `#${tag}`).join(' ');
}

export function formatRednoteHandoffText(caption: string, tags: string[]) {
  const body = caption.trim();
  const missingTags = getMissingTags(tags, body);
  const tagLine = formatTags(missingTags);
  return [body, tagLine].filter(Boolean).join('\n\n');
}

export function getMediaDownloadName(
  headline: string,
  mediaUrl: string,
  order: number,
  mimeType: string,
) {
  const normalizedMimeType = mimeType.trim().toLowerCase().split(';', 1)[0];
  const supportedExtensions: Record<string, readonly string[]> = {
    'image/avif': ['avif'],
    'image/heic': ['heic'],
    'image/heif': ['heif'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/png': ['png'],
    'image/webp': ['webp'],
    'video/mp4': ['mp4'],
    'video/quicktime': ['mov'],
  };
  const allowedExtensions = supportedExtensions[normalizedMimeType];
  if (!allowedExtensions) {
    throw new Error(`Unsupported prepared asset type: ${mimeType || 'missing Content-Type'}.`);
  }

  let urlExtension = '';
  try {
    urlExtension = new URL(mediaUrl).pathname.match(/\.([A-Za-z0-9]{2,5})$/)?.[1]
      ?.toLowerCase() ?? '';
  } catch {
    urlExtension = '';
  }
  const safeExtension = allowedExtensions.includes(urlExtension)
    ? urlExtension
    : allowedExtensions[0];
  const prefix = filenamePart(headline) || 'rednote-media';
  return `${prefix}-${String(order).padStart(2, '0')}.${safeExtension}`;
}

export async function prepareOrderedMediaFiles(
  headline: string,
  media: readonly { url: string }[],
) {
  return Promise.all(
    media.map(async (asset, index) => {
      const response = await fetch(asset.url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(
          `Asset ${index + 1} could not be prepared; no assets were prepared.`,
        );
      }
      const blob = await response.blob();
      const downloadName = getMediaDownloadName(
        headline,
        asset.url,
        index + 1,
        blob.type,
      );
      return new File(
        [blob],
        downloadName,
        { type: blob.type },
      );
    }),
  );
}

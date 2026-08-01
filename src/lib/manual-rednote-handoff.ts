export const REDNOTE_CREATOR_PUBLISH_URL =
  'https://creator.rednote.com/publish/publish';

export const SAFE_EXTERNAL_LINK_PROPS = {
  target: '_blank',
  rel: 'noopener noreferrer',
} as const;

interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export interface CopyHandoffResult {
  ok: boolean;
  message: string;
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

const CANONICAL_MEDIA_HOST = 'images.xhs.justlikekatie.com';

function canonicalMediaUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === CANONICAL_MEDIA_HOST
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function isCanonicalMediaVideo(url: string) {
  const parsed = canonicalMediaUrl(url);
  return parsed !== null
    && parsed.pathname.startsWith('/videos/assets/')
    && parsed.pathname.toLowerCase().endsWith('.mp4');
}

export function isCanonicalMediaMov(url: string) {
  const parsed = canonicalMediaUrl(url);
  return parsed !== null
    && parsed.pathname.startsWith('/videos/assets/')
    && parsed.pathname.toLowerCase().endsWith('.mov');
}

export function isCanonicalMediaImage(url: string) {
  const parsed = canonicalMediaUrl(url);
  return parsed !== null && /\.(?:jpe?g|png|webp)$/i.test(parsed.pathname);
}

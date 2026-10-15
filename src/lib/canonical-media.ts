function canonicalMediaUrl(url: string) {
  try {
    const authority = new URL(process.env.NEXT_PUBLIC_CANONICAL_MEDIA_ORIGIN ?? 'https://images.xhs.justlikekatie.com');
    if (authority.protocol !== 'https:' || authority.username || authority.password ||
        authority.port || authority.pathname !== '/' || authority.search || authority.hash) return null;
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.origin === authority.origin
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

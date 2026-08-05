const REDNOTE_NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REDNOTE_PUBLIC_HOSTS = new Set([
  'www.rednote.com',
  'www.xiaohongshu.com',
]);

export function isRednoteNoteId(value: string) {
  return REDNOTE_NOTE_ID.test(value);
}

export function normalizeRednoteShareUrl(noteId: string, value: string) {
  if (!isRednoteNoteId(noteId)) return null;
  try {
    const parsed = new URL(value);
    const expectedPath = `/explore/${noteId}`;
    if (
      parsed.protocol !== 'https:' ||
      !REDNOTE_PUBLIC_HOSTS.has(parsed.hostname) ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== expectedPath && parsed.pathname !== `${expectedPath}/`)
    ) {
      return null;
    }
    return `https://www.rednote.com${expectedPath}`;
  } catch {
    return null;
  }
}

export function normalizeRednotePublicIdentity(value: string) {
  const candidate = value.trim();
  if (isRednoteNoteId(candidate)) {
    return {
      noteId: candidate,
      shareUrl: `https://www.rednote.com/explore/${candidate}`,
    };
  }
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== 'https:' ||
      !REDNOTE_PUBLIC_HOSTS.has(parsed.hostname) ||
      parsed.port ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    const match = /^\/explore\/([A-Za-z0-9_-]{1,128})\/?$/.exec(parsed.pathname);
    if (!match) return null;
    const noteId = match[1];
    for (const key of ['noteId', 'note_id', 'id']) {
      if (parsed.searchParams.getAll(key).some((item) => item !== noteId)) {
        return null;
      }
    }
    return {
      noteId,
      shareUrl: `https://www.rednote.com/explore/${noteId}`,
    };
  } catch {
    return null;
  }
}

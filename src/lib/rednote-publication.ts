const REDNOTE_NOTE_ID = /^[A-Za-z0-9_-]+$/;

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
      !['www.rednote.com', 'www.xiaohongshu.com'].includes(parsed.hostname) ||
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

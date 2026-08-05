import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { ExternalPostSnapshot } from '@/types/local-publish-job';

const MAX_TITLE_LENGTH = 100;
const MAX_CAPTION_LENGTH = 5_000;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string') {
    throw new LocalPublishJobError(`${field} must be a string`, 'VALIDATION_ERROR', 400);
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, '').trim();
  if (!cleaned || cleaned.length > maxLength) {
    throw new LocalPublishJobError(
      `${field} must be between 1 and ${maxLength} characters`,
      'VALIDATION_ERROR',
      400,
    );
  }
  return cleaned;
}

export function parseExternalPostSnapshot(value: unknown): ExternalPostSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError(
      'Reconciliation body must be a JSON object',
      'VALIDATION_ERROR',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  const expected = ['caption', 'mediaType', 'noteId', 'shareUrl', 'title'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new LocalPublishJobError(
      'Reconciliation body contains unsupported fields',
      'VALIDATION_ERROR',
      400,
    );
  }

  const noteId = cleanText(body.noteId, 'noteId', 128);
  if (!/^[A-Za-z0-9_-]+$/.test(noteId)) {
    throw new LocalPublishJobError(
      'noteId contains unsupported characters',
      'INVALID_VERIFIED_POST',
      400,
    );
  }
  const shareUrl = cleanText(body.shareUrl, 'shareUrl', 500);
  if (shareUrl !== `https://www.rednote.com/explore/${noteId}`) {
    throw new LocalPublishJobError(
      'shareUrl must exactly match the verified RedNote explore URL for noteId',
      'INVALID_VERIFIED_POST',
      400,
    );
  }
  if (body.mediaType !== 'image' && body.mediaType !== 'video') {
    throw new LocalPublishJobError(
      'mediaType must be image or video',
      'VALIDATION_ERROR',
      400,
    );
  }
  return {
    noteId,
    shareUrl,
    title: cleanText(body.title, 'title', MAX_TITLE_LENGTH),
    caption: cleanText(body.caption, 'caption', MAX_CAPTION_LENGTH),
    mediaType: body.mediaType,
  };
}

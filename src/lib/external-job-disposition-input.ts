import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { normalizeRednotePublicIdentity } from '@/lib/rednote-publication';

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ExternalJobDispositionInput {
  notionPageId: string;
  localJobId: string;
  noteId: string;
  shareUrl: string;
}

function cleanText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string') {
    throw new LocalPublishJobError(
      `${field} must be a string`,
      'VALIDATION_ERROR',
      400,
    );
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

function exactKeys(value: Record<string, unknown>) {
  const legacy = [
    'confirmed',
    'localJobId',
    'noteId',
    'notionPageId',
    'shareUrl',
  ];
  const publicPost = [
    'confirmed',
    'localJobId',
    'notionPageId',
    'publicPost',
  ];
  const keys = Object.keys(value).sort();
  const matches = (expected: string[]) =>
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
  if (!matches(legacy) && !matches(publicPost)) {
    throw new LocalPublishJobError(
      'Request body contains unsupported fields',
      'VALIDATION_ERROR',
      400,
    );
  }
}

export function parseExternalJobDispositionInput(
  value: unknown,
): ExternalJobDispositionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError(
      'Request body must be a JSON object',
      'VALIDATION_ERROR',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  exactKeys(body);
  if (body.confirmed !== true) {
    throw new LocalPublishJobError(
      'Explicit operator confirmation is required',
      'CONFIRMATION_REQUIRED',
      400,
    );
  }
  const notionPageId = cleanText(body.notionPageId, 'notionPageId', 64);
  const localJobId = cleanText(body.localJobId, 'localJobId', 64).toLowerCase();
  if (!UUID.test(localJobId)) {
    throw new LocalPublishJobError(
      'localJobId must be an exact UUID',
      'VALIDATION_ERROR',
      400,
    );
  }
  const identity = 'publicPost' in body
    ? normalizeRednotePublicIdentity(cleanText(body.publicPost, 'publicPost', 500))
    : normalizeRednotePublicIdentity(cleanText(body.shareUrl, 'shareUrl', 500));
  if (!identity) {
    throw new LocalPublishJobError(
      'A bare note ID or allowed public RedNote explore URL is required',
      'INVALID_REDNOTE_IDENTITY',
      400,
    );
  }
  if (
    'noteId' in body &&
    cleanText(body.noteId, 'noteId', 128) !== identity.noteId
  ) {
    throw new LocalPublishJobError(
      'Explicit noteId conflicts with the public RedNote URL',
      'INVALID_REDNOTE_IDENTITY',
      400,
    );
  }
  return { notionPageId, localJobId, ...identity };
}

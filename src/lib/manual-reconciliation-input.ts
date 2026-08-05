import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { parseExternalPostSnapshot } from '@/lib/external-post-reconciliation-input';
import { normalizeRednotePublicIdentity } from '@/lib/rednote-publication';
import type { ExternalPostSnapshot } from '@/types/local-publish-job';

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function exactKeys(value: Record<string, unknown>, expected: string[], label: string) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new LocalPublishJobError(
      `${label} contains unsupported fields`,
      'VALIDATION_ERROR',
      400,
    );
  }
}

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

function safeCode(value: unknown) {
  const code = cleanText(value, 'code', 80);
  if (!/^[A-Z0-9_][A-Z0-9_.-]*$/.test(code)) {
    throw new LocalPublishJobError(
      'code must be an uppercase safe identifier',
      'VALIDATION_ERROR',
      400,
    );
  }
  return code;
}

function safeMessage(value: unknown) {
  const message = cleanText(value, 'message', 500).replace(/\s+/g, ' ');
  if (
    /https?:\/\//i.test(message) ||
    /\b(?:authorization|bearer|cookie|set-cookie|password|secret)\b/i.test(message) ||
    /\btoken\s*=/i.test(message)
  ) {
    throw new LocalPublishJobError(
      'message must not contain URLs or credential-like data',
      'UNSAFE_FAILURE_MESSAGE',
      400,
    );
  }
  return message;
}

export function normalizeManualRedNoteIdentity(value: unknown) {
  const publicPost = cleanText(value, 'publicPost', 500);
  const identity = normalizeRednotePublicIdentity(publicPost);
  if (!identity) {
    throw new LocalPublishJobError(
      'Use a bare note ID or an allowed public RedNote explore URL.',
      'INVALID_REDNOTE_IDENTITY',
      400,
    );
  }
  return identity;
}

export interface CreateManualReconciliationInput {
  notionPageId: string;
  noteId: string;
  shareUrl: string;
}

export function parseCreateManualReconciliationInput(
  value: unknown,
): CreateManualReconciliationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError(
      'Request body must be a JSON object',
      'VALIDATION_ERROR',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  exactKeys(body, ['confirmed', 'notionPageId', 'publicPost'], 'Request body');
  if (body.confirmed !== true) {
    throw new LocalPublishJobError(
      'Explicit operator confirmation is required',
      'CONFIRMATION_REQUIRED',
      400,
    );
  }
  const notionPageId = cleanText(body.notionPageId, 'notionPageId', 64);
  const identity = normalizeManualRedNoteIdentity(body.publicPost);
  return { notionPageId, ...identity };
}

export function parseManualReconciliationRetry(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError(
      'Retry body must be a JSON object',
      'VALIDATION_ERROR',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  exactKeys(body, ['confirmed'], 'Retry body');
  if (body.confirmed !== true) {
    throw new LocalPublishJobError(
      'Explicit operator confirmation is required',
      'CONFIRMATION_REQUIRED',
      400,
    );
  }
}

export type ManualReconciliationWorkerResult =
  | { status: 'verified'; snapshot: ExternalPostSnapshot }
  | { status: 'verification_pending'; code: string; message: string }
  | { status: 'failed'; code: string; message: string };

export function parseManualReconciliationWorkerResult(
  value: unknown,
): ManualReconciliationWorkerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError(
      'Result body must be a JSON object',
      'VALIDATION_ERROR',
      400,
    );
  }
  const body = value as Record<string, unknown>;
  if (body.status === 'verified') {
    exactKeys(body, ['snapshot', 'status'], 'Result body');
    return {
      status: 'verified',
      snapshot: parseExternalPostSnapshot(body.snapshot),
    };
  }
  if (body.status === 'verification_pending' || body.status === 'failed') {
    exactKeys(body, ['code', 'message', 'status'], 'Result body');
    return {
      status: body.status,
      code: safeCode(body.code),
      message: safeMessage(body.message),
    };
  }
  throw new LocalPublishJobError(
    'status must be verified, verification_pending, or failed',
    'VALIDATION_ERROR',
    400,
  );
}

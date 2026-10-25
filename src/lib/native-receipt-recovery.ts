import { isDeepStrictEqual } from 'util';
import { LocalPublishJobError } from './local-publish-job-input';

export const NATIVE_RECEIPT_RECOVERY = 'native-schedule-recovery/v1' as const;

/** Observation only: this claim never grants permission to stage or submit. */
export function nativeReceiptLookupClaim<T extends {
  status: string; noteId?: string; receiptOutcome?: string; dispatchAuthorizedAt?: string;
}>(job: T, attempt: {
  active: boolean; terminalOutcome: string | null;
  dispatchAuthorizedAt: string | null;
}) {
  const observationClaim = { ...job };
  delete observationClaim.receiptOutcome;
  delete observationClaim.dispatchAuthorizedAt;
  if (job.status !== 'verification_pending' || job.noteId ||
      job.receiptOutcome !== 'ambiguous' || attempt.active ||
      !['accepted', 'outcome_unknown'].includes(attempt.terminalOutcome || '') ||
      !Number.isFinite(Date.parse(attempt.dispatchAuthorizedAt || ''))) return observationClaim;
  return {
    ...observationClaim, status: 'identity_pending' as const,
    receiptLookup: {
      contractVersion: NATIVE_RECEIPT_RECOVERY,
      attemptedAt: attempt.dispatchAuthorizedAt!,
    },
  };
}

export function assertNativeRecoveryBinding(
  snapshot: Record<string, unknown>,
  frozen: Record<string, unknown>,
  receipt: {
    noteId?: string; scheduledFor: string; acknowledgedAt: string;
    authenticatedAccount: { accountId: string; capturedAt: string; ownership: string };
  },
  now = Date.now(),
) {
  const browser = frozen.browserPayload as Record<string, unknown> | undefined;
  const account = receipt.authenticatedAccount;
  const captured = Date.parse(account.capturedAt);
  const acknowledged = Date.parse(receipt.acknowledgedAt);
  if (!browser || frozen.timingMode !== 'scheduled' ||
      !/^[a-f0-9]{24}$/i.test(receipt.noteId || '') ||
      account.ownership !== 'owned' || !account.accountId ||
      account.accountId !== snapshot.expectedAccountId ||
      account.accountId !== browser.expectedAccountId ||
      !Number.isFinite(captured) || Math.abs(now - captured) > 300_000 ||
      !Number.isFinite(acknowledged) || Math.abs(now - acknowledged) > 300_000 ||
      !Number.isFinite(Date.parse(receipt.scheduledFor)) ||
      Date.parse(receipt.scheduledFor) !== Date.parse(String(frozen.targetPublishAt)) ||
      Date.parse(receipt.scheduledFor) !== Date.parse(String(snapshot.publishAt)) ||
      !['title', 'caption', 'tags'].every(key =>
        isDeepStrictEqual(snapshot[key], browser[key]))) {
    throw new LocalPublishJobError(
      'Native receipt does not match the frozen owned packet',
      'NATIVE_RECEIPT_BINDING_MISMATCH', 409,
    );
  }
}

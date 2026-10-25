/** Projection only: never changes attempts, authorizations or provider receipts. */
export function rednoteDispatchOutcome(input: {
  status: string;
  terminalOutcome: string | null;
  receiptLookupState: string | null;
  receiptOutcome?: string | null;
  receiptAcknowledgedAt?: string | null;
  errorCode?: string | null;
  failureAt?: string | null;
}) {
  const recoveredSchedule = input.terminalOutcome !== 'known_failed' &&
    input.receiptLookupState === 'found' && input.receiptOutcome === 'scheduled' &&
    typeof input.receiptAcknowledgedAt === 'string' &&
    Number.isFinite(Date.parse(input.receiptAcknowledgedAt));
  const providerAccepted = input.terminalOutcome === 'accepted' || recoveredSchedule;
  const failed = input.terminalOutcome === 'known_failed' ||
    (input.status === 'failed' && input.terminalOutcome === null);
  return {
    state: failed
      ? 'failed'
      : input.terminalOutcome === 'outcome_unknown' && !recoveredSchedule
        ? 'identity_pending'
        : recoveredSchedule && input.status === 'verification_pending'
          ? 'scheduled'
        : providerAccepted && input.status === 'scheduled'
          ? 'scheduled'
          : input.receiptLookupState === 'identity_pending'
            ? 'identity_pending'
            : input.status,
    providerAccepted,
    failed,
    failure: failed
      ? input.errorCode === 'NOT_LOGGED_IN'
        ? `Creator sign-in check failed${input.failureAt && Number.isFinite(Date.parse(input.failureAt))
          ? ` (${new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          }).format(new Date(input.failureAt))})` : ''}. After the session is restored, review and explicitly request Ready ×3 again; this is not a provider receipt.`
        : 'Publishing attempt failed'
      : null,
  };
}

/** A resolved identity or native schedule acknowledgement is not public evidence. */
export function rednotePublicReceiptVerified(input: {
  status: string; publicIndexStatus: string | null; canonicalUrl: string | null;
  verifiedAt: string | null;
}) {
  return ['verified', 'reconciled'].includes(input.status) &&
    input.publicIndexStatus === 'indexed' &&
    Boolean(input.canonicalUrl) && typeof input.verifiedAt === 'string' &&
    Number.isFinite(Date.parse(input.verifiedAt));
}

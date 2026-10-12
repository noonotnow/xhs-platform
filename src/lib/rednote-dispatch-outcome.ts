/** Projection only: never changes attempts, authorizations or provider receipts. */
export function rednoteDispatchOutcome(input: {
  status: string;
  terminalOutcome: string | null;
  receiptLookupState: string | null;
}) {
  const providerAccepted = input.terminalOutcome === 'accepted';
  const failed = input.terminalOutcome === 'known_failed' ||
    (input.status === 'failed' && input.terminalOutcome === null);
  return {
    state: failed
      ? 'failed'
      : input.terminalOutcome === 'outcome_unknown'
        ? 'identity_pending'
        : providerAccepted && input.status === 'scheduled'
          ? 'scheduled'
          : input.receiptLookupState === 'identity_pending'
            ? 'identity_pending'
            : input.status,
    providerAccepted,
    failed,
    failure: failed ? 'Publishing attempt failed' : null,
  };
}

import { describe, expect, it, vi } from 'vitest';
import { assessReadyX3SourceMutation, inspectReadyX3SourceMutation, readReadyX3SourceMutationSafety, type MutationSafetyRow } from './ready-x3-source-mutation-safety';

vi.mock('@/lib/db', () => ({ getPool: vi.fn() }));
import { getPool } from '@/lib/db';

const failed = (): MutationSafetyRow => ({
  status: 'failed', authorization_kind: 'ready_x3', active: false,
  terminal_outcome: 'known_failed', receipt_lookup_state: 'not_required',
  job_dispatch_authorized_at: null, attempt_dispatch_authorized_at: null,
  dispatched_at: null, verified_at: null, reconciled_at: null, note_id: null,
  share_url: null, success_attestation_id: null, receipt_outcome: 'rejected',
});

describe('Ready x3 source mutation authority, not retry authority', () => {
  it('permits an old, affirmatively pre-activation failure without batch recovery metadata', () => {
    expect(assessReadyX3SourceMutation([failed()], false, false)).toEqual({ applicable: true, safe: true });
  });
  it.each(['queued', 'claimed', 'staged'])('permits %s only while actual fencing can revoke activation', (status) => {
    expect(assessReadyX3SourceMutation([{ ...failed(), status, active: true, terminal_outcome: null, receipt_outcome: null }], false, false).safe).toBe(true);
  });
  it.each([
    ['job_dispatch_authorized_at', 'timestamp'], ['attempt_dispatch_authorized_at', 'timestamp'],
    ['dispatched_at', 'timestamp'], ['verified_at', 'timestamp'], ['reconciled_at', 'timestamp'],
    ['note_id', 'note'], ['share_url', 'url'], ['success_attestation_id', 'id'],
    ['terminal_outcome', 'outcome_unknown'], ['receipt_lookup_state', 'identity_pending'],
    ['receipt_outcome', 'scheduled'], ['receipt_outcome', 'acknowledged'],
    ['receipt_outcome', 'ambiguous'], ['status', 'scheduled'], ['active', true],
  ])('blocks %s evidence rather than inferring unpublished from an error', (key, value) => {
    expect(assessReadyX3SourceMutation([{ ...failed(), [key]: value }], false, false).safe).toBe(false);
  });
  it('checks all history, missing bindings, and unrelated lanes', () => {
    expect(assessReadyX3SourceMutation([failed(), { ...failed(), note_id: 'old-public-note' }], false, false).safe).toBe(false);
    expect(assessReadyX3SourceMutation([failed(), { ...failed(), authorization_kind: null }], false, false).safe).toBe(false);
    expect(assessReadyX3SourceMutation([failed()], true, false).safe).toBe(false);
    expect(assessReadyX3SourceMutation([], true, true)).toEqual({ applicable: true, safe: false });
    expect(assessReadyX3SourceMutation([], false, false)).toEqual({ applicable: false, safe: false });
  });
  it('uses only the caller PoolClient and binds both workspace and canonical source', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [failed()] }).mockResolvedValueOnce({ rows: [{ any_orphan: false, ready_x3_orphan: false }] });
    expect(await inspectReadyX3SourceMutation({ query } as never, 'workspace', 'post')).toEqual({ applicable: true, safe: true });
    expect(query.mock.calls.every((call) => JSON.stringify(call[1]) === '["workspace","post"]')).toBe(true);
    expect(query.mock.calls[0][0]).toContain('attempt.source_notion_page_id=job.notion_page_id');
    expect(getPool).not.toHaveBeenCalled();
  });
  it('takes the source lock and returns a fresh observation without changing jobs or attempts', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('LEFT JOIN') ? [failed()] : sql.includes('any_orphan') ? [{ any_orphan: false, ready_x3_orphan: false }] : [] }));
    const release = vi.fn();
    vi.mocked(getPool).mockReturnValue({ connect: async () => ({ query, release }) } as never);
    const result = await readReadyX3SourceMutationSafety('workspace', 'post');
    expect(result.safe).toBe(true);
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
    expect(query.mock.calls[1]).toEqual(['SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['workspace:post']]);
    expect(query.mock.calls.some(([sql]) => /\b(UPDATE|INSERT|DELETE)\b/.test(sql))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});

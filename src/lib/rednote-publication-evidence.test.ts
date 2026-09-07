import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/db', () => ({ sql: mocks.sql }));

import {
  parseRednotePublicationEvidence,
  recordRednotePublicationEvidence,
} from '@/lib/rednote-publication-evidence';

const noteId = 'note_123';

describe('RedNote publication evidence', () => {
  beforeEach(() => mocks.sql.mockReset());

  it('accepts renewable evidence without accepting xsec tokens', () => {
    expect(parseRednotePublicationEvidence(noteId, {
      contractVersion: 'rednote-evidence/v1',
      kind: 'xsec_access',
      capturedAt: '2026-08-02T12:00:00Z',
      accessible: true,
    })).toEqual({
      contractVersion: 'rednote-evidence/v1',
      kind: 'xsec_access',
      capturedAt: '2026-08-02T12:00:00.000Z',
      accessible: true,
    });
    expect(() => parseRednotePublicationEvidence(noteId, {
      contractVersion: 'rednote-evidence/v1',
      kind: 'xsec_access',
      capturedAt: '2026-08-02T12:00:00Z',
      accessible: true,
      xsecToken: 'secret',
    })).toThrow('unsupported fields');
    expect(() => parseRednotePublicationEvidence(noteId, {
      contractVersion: 'rednote-evidence/v1',
      kind: 'authenticated_account',
      capturedAt: '2026-08-02T12:00:00Z',
      accountId: 'creator-account-1',
      ownership: 'owned',
      cookies: 'secret',
    })).toThrow('unsupported fields');
  });

  it('refreshes xsec evidence using the newest capture timestamp', async () => {
    mocks.sql.mockResolvedValue({
      rows: [{
        note_id: noteId,
        expected_account_id: 'creator-account-1',
        authenticated_account_id: 'creator-account-1',
        authenticated_account_at: '2026-08-01T12:00:00Z',
        xsec_accessible_at: '2026-08-02T12:00:00Z',
        public_index_status: 'pending',
        public_index_checked_at: '2026-08-01T12:00:00Z',
        public_url: null,
        restriction_status: null,
        restriction_reported_at: null,
      }],
      rowCount: 1,
    });
    await expect(recordRednotePublicationEvidence('workspace-1', noteId, {
      contractVersion: 'rednote-evidence/v1',
      kind: 'xsec_access',
      capturedAt: '2026-08-02T12:00:00.000Z',
      accessible: true,
    })).resolves.toMatchObject({
      noteId,
      xsecAccess: {
        accessible: true,
        capturedAt: '2026-08-02T12:00:00.000Z',
      },
    });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain('job.xsec_accessible_at <=');
    expect(query).not.toContain('xsec_token');
  });

  it('records delayed public indexing without changing publication status', async () => {
    mocks.sql.mockResolvedValue({
      rows: [{
        note_id: noteId,
        expected_account_id: 'creator-account-1',
        authenticated_account_id: 'creator-account-1',
        authenticated_account_at: '2026-08-01T12:00:00Z',
        xsec_accessible_at: null,
        public_index_status: 'indexed',
        public_index_checked_at: '2026-08-03T12:00:00Z',
        public_url: 'https://www.rednote.com/explore/note_123',
        restriction_status: null,
        restriction_reported_at: null,
      }],
      rowCount: 1,
    });
    await expect(recordRednotePublicationEvidence('workspace-1', noteId, {
      contractVersion: 'rednote-evidence/v1',
      kind: 'public_index',
      capturedAt: '2026-08-03T12:00:00.000Z',
      status: 'indexed',
      publicUrl: 'https://www.rednote.com/explore/note_123',
    })).resolves.toMatchObject({
      publicIndex: {
        status: 'indexed',
        publicUrl: 'https://www.rednote.com/explore/note_123',
      },
    });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).not.toContain("SET status =");
    expect(query).toContain('public_index_checked_at <=');
  });

  it('audits an account mismatch and fails closed', async () => {
    mocks.sql.mockResolvedValue({
      rows: [{
        note_id: noteId,
        expected_account_id: 'creator-account-1',
        authenticated_account_id: null,
        authenticated_account_at: null,
        xsec_accessible_at: null,
        public_index_status: null,
        public_index_checked_at: null,
        public_url: null,
        restriction_status: null,
        restriction_reported_at: null,
      }],
      rowCount: 1,
    });
    await expect(recordRednotePublicationEvidence('workspace-1', noteId, {
      contractVersion: 'rednote-evidence/v1',
      kind: 'authenticated_account',
      capturedAt: '2026-08-02T12:00:00.000Z',
      accountId: 'wrong-account',
      ownership: 'owned',
    })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
    expect(mocks.sql).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  listReadyPosts: vi.fn(),
  publishReadyPost: vi.fn(),
  getSessionStatus: vi.fn(),
  getQrCode: vi.fn(),
  checkLoginStatus: vi.fn(),
  loginWithCookie: vi.fn(),
}));

vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));

vi.mock('@/lib/notion-posts', () => ({
  listReadyXhsPosts: mocks.listReadyPosts,
  NotionPostsError: class NotionPostsError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status = 500,
    ) {
      super(message);
    }
  },
}));

vi.mock('@/lib/ready-post-publisher', () => ({
  publishReadyPost: mocks.publishReadyPost,
  normalizePublishError: (error: Error) => error,
  ReadyPostPublishError: class ReadyPostPublishError extends Error {
    readonly code = 'TEST_ERROR';
    readonly status = 500;
  },
}));

vi.mock('@/lib/xhs-microservice', () => ({
  XhsMicroserviceHttpError: class XhsMicroserviceHttpError extends Error {
    readonly detail: string;

    constructor(
      readonly status: number,
      readonly responseBody: string,
    ) {
      super(`Microservice error ${status}: ${responseBody}`);
      this.detail = 'Normal-account QR login is temporarily unavailable';
    }
  },
  getSessionStatus: mocks.getSessionStatus,
  getQRCode: mocks.getQrCode,
  checkLoginStatus: mocks.checkLoginStatus,
  loginWithCookie: mocks.loginWithCookie,
}));

import { GET as getReadyPosts } from '@/app/api/xhs/ready-posts/route';
import { POST as publishReadyPost } from '@/app/api/xhs/ready-posts/[pageId]/publish/route';
import { GET as getSession } from '@/app/api/xhs/session/route';
import { GET as getQrCode } from '@/app/api/xhs/login/qr/route';
import { GET as getLoginStatus } from '@/app/api/xhs/login/status/route';
import { POST as postCookie } from '@/app/api/xhs/login/cookie/route';

function request(path: string, init?: RequestInit) {
  return new NextRequest(`https://xhs.justlikekatie.com${path}`, init);
}

describe('protected XHS route handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOperator.mockResolvedValue(null);
  });

  it('returns the ready queue as JSON', async () => {
    mocks.listReadyPosts.mockResolvedValue({ posts: [], warnings: [] });

    const response = await getReadyPosts(request('/api/xhs/ready-posts'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ posts: [], warnings: [] });
  });

  it('serializes unexpected ready queue failures as JSON', async () => {
    mocks.listReadyPosts.mockRejectedValue(new Error('Notion unavailable'));

    const response = await getReadyPosts(request('/api/xhs/ready-posts'));

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to load ready posts',
      code: 'READY_POSTS_LOAD_FAILED',
    });
  });

  it('executes the confirmed publish handler', async () => {
    mocks.publishReadyPost.mockResolvedValue({
      status: 'success',
      noteId: 'note-123',
      shareUrl: 'https://www.xiaohongshu.com/explore/note-123',
    });
    const body = { confirmed: true, lastEditedTime: '2026-07-31T00:00:00.000Z' };

    const response = await publishReadyPost(
      request('/api/xhs/ready-posts/page-id/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: { pageId: 'page-id' } },
    );

    expect(response.status).toBe(201);
    expect(mocks.publishReadyPost).toHaveBeenCalledWith('page-id', body);
  });

  it('executes the session handler', async () => {
    mocks.getSessionStatus.mockResolvedValue({ valid: false });

    const response = await getSession(request('/api/xhs/session'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ valid: false });
  });

  it('executes QR start and status handlers', async () => {
    mocks.getQrCode.mockResolvedValue({
      qr_id: 'id',
      code: 'code',
      url: 'xhsdiscover://login/qr?code=creator',
    });
    mocks.checkLoginStatus.mockResolvedValue({ code_status: 0, login_info: null });

    const qrResponse = await getQrCode(request('/api/xhs/login/qr'));
    const statusResponse = await getLoginStatus(request('/api/xhs/login/status'));

    expect(qrResponse.status).toBe(200);
    await expect(qrResponse.json()).resolves.toMatchObject({
      url: 'xhsdiscover://login/qr?code=creator',
    });
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({ code_status: 0 });
  });

  it('rejects merchant QR targets without returning the URL', async () => {
    mocks.getQrCode.mockResolvedValue({
      qr_id: 'id',
      code: 'code',
      url: encodeURIComponent('xhsdiscover://login/qr?redirect=xymerchant'),
    });

    const response = await getQrCode(request('/api/xhs/login/qr'));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      detail:
        'Merchant/Qianfan login is not supported for this Rednote creator account. ' +
        'Use manual cookie login from https://creator.rednote.com/login.',
    });
    expect(JSON.stringify(body)).not.toContain('xymerchant');
  });

  it('does not expose unexpected QR failures', async () => {
    mocks.getQrCode.mockRejectedValue(
      new SyntaxError('Unexpected token in secret-token-response'),
    );

    const response = await getQrCode(request('/api/xhs/login/qr'));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      detail: 'Unable to start normal-account Rednote QR login.',
    });
    expect(JSON.stringify(body)).not.toContain('secret-token');
  });

  it('executes the cookie handler without exposing the cookie to the browser response', async () => {
    mocks.loginWithCookie.mockResolvedValue({ status: 'ok' });

    const response = await postCookie(request('/api/xhs/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: 'session=value' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.loginWithCookie).toHaveBeenCalledWith('session=value');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});

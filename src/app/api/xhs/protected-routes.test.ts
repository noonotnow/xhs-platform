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
    readonly safeBody: object;

    constructor(
      readonly status: number,
      readonly responseBody: string,
    ) {
      super(`Microservice error ${status}: ${responseBody}`);
      this.detail = 'Normal-account QR login is temporarily unavailable';
      const body = JSON.parse(responseBody);
      this.safeBody = {
        ...(typeof body.valid === 'boolean' ? { valid: body.valid } : {}),
        ...(body.session_type ? { session_type: body.session_type } : {}),
        ...(typeof body.relogin_required === 'boolean'
          ? { relogin_required: body.relogin_required }
          : {}),
        ...(body.error ? { error: body.error } : {}),
        ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
      };
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
import { CREATOR_QR_UNAVAILABLE_DETAIL } from '@/lib/xhs-creator-login';

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

  it('sanitizes object-shaped session errors returned with a successful response', async () => {
    mocks.getSessionStatus.mockResolvedValue({
      valid: false,
      session_type: 'rednote_creator',
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'The creator session is invalid',
      },
      cookie: 'must-not-leak',
    });

    const response = await getSession(request('/api/xhs/session'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      valid: false,
      session_type: 'rednote_creator',
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'The creator session is invalid',
      },
    });
  });

  it('preserves a structured creator-session validation outage status', async () => {
    mocks.getSessionStatus.mockRejectedValue(new (
      await import('@/lib/xhs-microservice')
    ).XhsMicroserviceHttpError(502, JSON.stringify({
      error: {
        code: 'creator_session_validation_unavailable',
        message: 'Creator validation is temporarily unavailable',
      },
      internal: 'must-not-leak',
    })));

    const response = await getSession(request('/api/xhs/session'));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'creator_session_validation_unavailable',
        message: 'Creator validation is temporarily unavailable',
      },
    });
  });

  it('fails QR start and status closed without requesting a QR URL', async () => {
    const qrResponse = await getQrCode(request('/api/xhs/login/qr'));
    const statusResponse = await getLoginStatus(request('/api/xhs/login/status'));

    expect(qrResponse.status).toBe(503);
    expect(qrResponse.headers.get('cache-control')).toContain('no-store');
    await expect(qrResponse.json()).resolves.toEqual({
      detail: CREATOR_QR_UNAVAILABLE_DETAIL,
    });
    expect(statusResponse.status).toBe(503);
    expect(statusResponse.headers.get('cache-control')).toContain('no-store');
    await expect(statusResponse.json()).resolves.toEqual({
      detail: CREATOR_QR_UNAVAILABLE_DETAIL,
    });
    expect(mocks.getQrCode).not.toHaveBeenCalled();
    expect(mocks.checkLoginStatus).not.toHaveBeenCalled();
  });

  it('executes the cookie handler without exposing the cookie to the browser response', async () => {
    mocks.loginWithCookie.mockResolvedValue({
      valid: true,
      session_type: 'rednote_creator',
    });

    const response = await postCookie(request('/api/xhs/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: 'session=value' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.loginWithCookie).toHaveBeenCalledWith('session=value');
    await expect(response.json()).resolves.toEqual({
      valid: true,
      session_type: 'rednote_creator',
    });
  });

  it('preserves a sanitized invalid-session response without exposing the cookie', async () => {
    mocks.loginWithCookie.mockRejectedValue(new (
      await import('@/lib/xhs-microservice')
    ).XhsMicroserviceHttpError(401, JSON.stringify({
      valid: false,
      session_type: 'rednote_creator',
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'The creator session is invalid',
      },
    })));

    const response = await postCookie(request('/api/xhs/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: 'sensitive=session' }),
    }));

    expect(response.status).toBe(401);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      valid: false,
      session_type: 'rednote_creator',
      relogin_required: true,
      error: {
        code: 'creator_session_invalid',
        message: 'The creator session is invalid',
      },
    });
    expect(JSON.stringify(responseBody)).not.toContain('sensitive=session');
  });
});

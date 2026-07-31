import { describe, expect, it } from 'vitest';
import { responseJson } from '@/lib/response-json';

describe('responseJson', () => {
  it('parses JSON object responses', async () => {
    const response = new Response(JSON.stringify({ posts: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });

    await expect(responseJson(response, 'GET /admin/api/ready-posts'))
      .resolves.toEqual({ posts: [] });
  });

  it('reports an HTML response with request path and status', async () => {
    const response = new Response('<!DOCTYPE html><title>Sign in</title>', {
      status: 302,
      statusText: 'Found',
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });

    await expect(responseJson(response, 'GET /admin/api/ready-posts'))
      .rejects.toThrow(
        'GET /admin/api/ready-posts returned 302 Found with text/html; charset=utf-8; expected JSON.',
      );
  });

  it('reports malformed JSON without exposing a parser exception', async () => {
    const response = new Response('<html>', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(responseJson(response, 'POST /admin/api/ready-posts/id/publish'))
      .rejects.toThrow(
        'POST /admin/api/ready-posts/id/publish returned invalid JSON (502 Bad Gateway).',
      );
  });
});

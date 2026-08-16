import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  hash: vi.fn(),
  signToken: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ sql: mocks.sql }));
vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash } }));
vi.mock('@/lib/auth', () => ({ signToken: mocks.signToken }));

import { POST } from './route';

const validBody = { email: 'test@example.com', password: 'password123' };
const userId = '11111111-1111-4111-8111-111111111111';

function request(body: unknown) {
  return new NextRequest('https://xhs.justlikekatie.com/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hash.mockResolvedValue('hashed-password');
    mocks.sql.mockResolvedValue({
      rows: [{ id: userId, email: 'test@example.com', name: null }],
    });
    mocks.signToken.mockResolvedValue('signed-jwt-token');
  });

  it('creates a user and returns a JWT token', async () => {
    const response = await POST(request(validBody));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      token: 'signed-jwt-token',
      user: { id: userId, email: 'test@example.com' },
    });
  });

  it('hashes the password before storing', async () => {
    await POST(request(validBody));
    expect(mocks.hash).toHaveBeenCalledWith('password123', 10);
  });

  it('normalises the email to lowercase before insert', async () => {
    await POST(request({ ...validBody, email: 'TEST@Example.COM' }));
    // The sql tagged template receives the normalised email as a value
    expect(mocks.sql).toHaveBeenCalled();
    const sqlArgs = mocks.sql.mock.calls[0];
    expect(sqlArgs).toEqual(
      expect.arrayContaining(['test@example.com']),
    );
  });

  it('signs the token with the new user id and email', async () => {
    await POST(request(validBody));
    expect(mocks.signToken).toHaveBeenCalledWith({
      userId,
      email: 'test@example.com',
    });
  });

  it('returns 400 when email is missing', async () => {
    const response = await POST(request({ password: 'password123' }));
    expect(response.status).toBe(400);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('returns 400 when email has no @ sign', async () => {
    const response = await POST(request({ email: 'notanemail', password: 'password123' }));
    expect(response.status).toBe(400);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('returns 400 when password is shorter than 8 characters', async () => {
    const response = await POST(request({ email: 'test@example.com', password: 'short' }));
    expect(response.status).toBe(400);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('returns 409 when the email is already registered', async () => {
    mocks.sql.mockRejectedValue({ code: '23505' });
    const response = await POST(request(validBody));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/already registered/i);
  });

  it('returns 500 when an unexpected database error occurs', async () => {
    mocks.sql.mockRejectedValue(new Error('connection refused'));
    const response = await POST(request(validBody));
    expect(response.status).toBe(500);
  });
});

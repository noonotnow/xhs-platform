import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  compare: vi.fn(),
  signToken: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ sql: mocks.sql }));
vi.mock('bcryptjs', () => ({ default: { compare: mocks.compare } }));
vi.mock('@/lib/auth', () => ({ signToken: mocks.signToken }));

import { POST } from './route';

const userId = '11111111-1111-4111-8111-111111111111';
const storedUser = {
  id: userId,
  email: 'test@example.com',
  name: 'Test User',
  password_hash: 'hashed-password',
};

function request(body: unknown) {
  return new NextRequest('https://xhs.justlikekatie.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockResolvedValue({ rows: [storedUser] });
    mocks.compare.mockResolvedValue(true);
    mocks.signToken.mockResolvedValue('signed-jwt-token');
  });

  it('returns a JWT token on successful login', async () => {
    const response = await POST(
      request({ email: 'test@example.com', password: 'password123' }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      token: 'signed-jwt-token',
      user: { id: userId, email: 'test@example.com', name: 'Test User' },
    });
  });

  it('looks up the user by normalised lowercase email', async () => {
    await POST(request({ email: 'TEST@Example.COM', password: 'password123' }));
    const sqlArgs = mocks.sql.mock.calls[0];
    expect(sqlArgs).toEqual(expect.arrayContaining(['test@example.com']));
  });

  it('signs the token with the stored user id and email', async () => {
    await POST(request({ email: 'test@example.com', password: 'password123' }));
    expect(mocks.signToken).toHaveBeenCalledWith({
      userId,
      email: 'test@example.com',
    });
  });

  it('returns 401 when the user is not found', async () => {
    mocks.sql.mockResolvedValue({ rows: [] });
    const response = await POST(
      request({ email: 'unknown@example.com', password: 'password123' }),
    );
    expect(response.status).toBe(401);
    expect(mocks.signToken).not.toHaveBeenCalled();
  });

  it('returns 401 when the password does not match', async () => {
    mocks.compare.mockResolvedValue(false);
    const response = await POST(
      request({ email: 'test@example.com', password: 'wrong-password' }),
    );
    expect(response.status).toBe(401);
    expect(mocks.signToken).not.toHaveBeenCalled();
  });

  it('returns the same 401 message for missing user and wrong password', async () => {
    mocks.sql.mockResolvedValue({ rows: [] });
    const notFoundResponse = await POST(
      request({ email: 'unknown@example.com', password: 'any' }),
    );

    mocks.sql.mockResolvedValue({ rows: [storedUser] });
    mocks.compare.mockResolvedValue(false);
    const wrongPasswordResponse = await POST(
      request({ email: 'test@example.com', password: 'wrong' }),
    );

    const notFoundBody = await notFoundResponse.json();
    const wrongPasswordBody = await wrongPasswordResponse.json();
    expect(notFoundBody.error).toBe(wrongPasswordBody.error);
  });

  it('returns 400 when email is missing', async () => {
    const response = await POST(request({ password: 'password123' }));
    expect(response.status).toBe(400);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('returns 400 when password is missing', async () => {
    const response = await POST(request({ email: 'test@example.com' }));
    expect(response.status).toBe(400);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('returns 500 when an unexpected database error occurs', async () => {
    mocks.sql.mockRejectedValue(new Error('connection refused'));
    const response = await POST(
      request({ email: 'test@example.com', password: 'password123' }),
    );
    expect(response.status).toBe(500);
  });
});

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { sql } from '@/lib/db';
import { signToken } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password, name } = body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json(
        { error: 'Valid email is required' },
        { status: 400 },
      );
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 },
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    let result;
    try {
      result = await sql`
        INSERT INTO users (email, password_hash, name)
        VALUES (${email.toLowerCase().trim()}, ${passwordHash}, ${name ?? null})
        RETURNING id, email, name
      `;
    } catch (err: unknown) {
      // Unique constraint violation (duplicate email)
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        return NextResponse.json(
          { error: 'Email is already registered' },
          { status: 409 },
        );
      }
      throw err;
    }

    const user = result.rows[0];
    const token = await signToken({ userId: user.id, email: user.email });

    return NextResponse.json(
      { token, user: { id: user.id, email: user.email, name: user.name } },
      { status: 201 },
    );
  } catch (error) {
    console.error('Signup error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

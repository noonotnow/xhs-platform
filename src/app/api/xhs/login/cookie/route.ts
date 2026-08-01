import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import {
  loginWithCookie,
  XhsMicroserviceHttpError,
} from '@/lib/xhs-microservice';
import { sanitizeCreatorSessionResponse } from '@/lib/xhs-creator-session';

export async function POST(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) return unauthorized;
  try {
    const { cookie } = await request.json();
    if (typeof cookie !== 'string' || !cookie.trim()) {
      return NextResponse.json(
        { error: { code: 'cookie_required', message: 'Cookie is required' } },
        { status: 400 },
      );
    }
    const result = await loginWithCookie(cookie);
    return NextResponse.json(sanitizeCreatorSessionResponse(result));
  } catch (e: unknown) {
    if (e instanceof XhsMicroserviceHttpError) {
      return NextResponse.json(e.safeBody, { status: e.status });
    }
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

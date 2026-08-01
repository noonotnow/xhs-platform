import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import {
  loginWithCookie,
  XhsMicroserviceHttpError,
} from '@/lib/xhs-microservice';
import {
  sanitizeCreatorCookieLoginErrorResponse,
  sanitizeCreatorCookieLoginSuccessResponse,
} from '@/lib/xhs-creator-session';

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
    const safeResult = sanitizeCreatorCookieLoginSuccessResponse(result);
    return NextResponse.json(
      safeResult,
      { status: safeResult.valid === true ? 200 : 502 },
    );
  } catch (e: unknown) {
    if (e instanceof XhsMicroserviceHttpError) {
      return NextResponse.json(
        sanitizeCreatorCookieLoginErrorResponse(e.safeBody),
        { status: e.status },
      );
    }
    return NextResponse.json(
      sanitizeCreatorCookieLoginErrorResponse(undefined),
      { status: 500 },
    );
  }
}

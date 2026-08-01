import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import {
  getSessionStatus,
  XhsMicroserviceHttpError,
} from '@/lib/xhs-microservice';
import { sanitizeCreatorSessionResponse } from '@/lib/xhs-creator-session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) return unauthorized;
  try {
    const status = await getSessionStatus();
    return NextResponse.json(sanitizeCreatorSessionResponse(status));
  } catch (e: unknown) {
    if (e instanceof XhsMicroserviceHttpError) {
      return NextResponse.json(e.safeBody, { status: e.status });
    }
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

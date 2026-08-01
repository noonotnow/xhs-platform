import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import {
  CREATOR_QR_UNAVAILABLE_DETAIL,
  QR_NO_STORE_HEADERS,
} from '@/lib/xhs-creator-login';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) return unauthorized;
  return NextResponse.json(
    { detail: CREATOR_QR_UNAVAILABLE_DETAIL },
    { status: 503, headers: QR_NO_STORE_HEADERS },
  );
}

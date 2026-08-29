import { NextResponse } from 'next/server';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';
import { timingSafeEqual } from 'crypto';

function validOperatorBearer(header: string | null) {
  const configured = process.env.XHS_PLATFORM_OPERATOR_TOKEN?.trim()
    || process.env.XHS_PLATFORM_API_TOKEN?.trim();
  const supplied = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!configured || !supplied) return false;
  const left = Buffer.from(configured);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function requireXhsOperator(
  request: Pick<Request, 'headers'>,
): Promise<NextResponse | null> {
  if (validOperatorBearer(request.headers.get('authorization'))) return null;
  try {
    await validateCloudflareAccessRequest(request);
    return null;
  } catch (error) {
    console.warn(
      'XHS operator access denied:',
      error instanceof Error ? error.message : 'Unknown validation error',
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

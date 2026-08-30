import { NextResponse } from 'next/server';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';
import { timingSafeEqual } from 'crypto';

function validOperatorToken(headers: Headers) {
  const configured = process.env.XHS_PLATFORM_OPERATOR_TOKEN?.trim()
    || process.env.XHS_PLATFORM_API_TOKEN?.trim();
  const dedicated = headers.get('x-xhs-operator-token')?.trim();
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = dedicated || bearer;
  if (!configured || !supplied) return false;
  const left = Buffer.from(configured);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function requireXhsOperator(
  request: Pick<Request, 'headers'>,
): Promise<NextResponse | null> {
  if (validOperatorToken(request.headers)) return null;
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

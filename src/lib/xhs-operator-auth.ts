import { NextResponse } from 'next/server';
    import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';
    import { timingSafeEqual } from 'crypto';

    type OperatorTokenCheck = 'authorized' | 'not_configured' | 'not_supplied' | 'mismatch';

    function checkOperatorToken(headers: Headers): OperatorTokenCheck {
    const configured = process.env.XHS_PLATFORM_OPERATOR_TOKEN?.trim()
      || process.env.XHS_PLATFORM_API_TOKEN?.trim();
    const dedicated = headers.get('x-xhs-operator-token')?.trim();
    const bearer = headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const supplied = dedicated || bearer;
    if (!configured) return 'not_configured';
    if (!supplied) return 'not_supplied';
    const left = Buffer.from(configured);
    const right = Buffer.from(supplied);
    return left.length === right.length && timingSafeEqual(left, right)
      ? 'authorized'
      : 'mismatch';
    }

    export async function requireXhsOperator(
    request: Pick<Request, 'headers'>,
    ): Promise<NextResponse | null> {
    const tokenCheck = checkOperatorToken(request.headers);
    if (tokenCheck === 'authorized') return null;
    try {
      await validateCloudflareAccessRequest(request);
      return null;
    } catch (error) {
      console.warn(
        'XHS operator access denied:',
        error instanceof Error ? error.message : 'Unknown validation error',
      );
      return NextResponse.json(
        { error: 'Unauthorized', code: 'XHS_OPERATOR_AUTH_' + tokenCheck.toUpperCase() },
        { status: 401, headers: { 'X-XHS-Auth-Reason': tokenCheck } },
      );
    }
    }
    
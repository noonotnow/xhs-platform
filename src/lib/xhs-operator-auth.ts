import { NextResponse } from 'next/server';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';
import { timingSafeEqual } from 'crypto';

type OperatorTokenCheck = 'authorized' | 'not_configured' | 'not_supplied' | 'mismatch';

function checkOperatorToken(headers: Headers): OperatorTokenCheck {
  const configured = [
    process.env.XHS_PLATFORM_OPERATOR_TOKEN?.trim(),
    process.env.XHS_PLATFORM_API_TOKEN?.trim(),
    process.env.XHS_PLATFORM_ACCEPTANCE_TOKEN?.trim(),
  ].filter((token): token is string => Boolean(token));
  const configuredTokens = configured.filter(
    (token, index) => configured.indexOf(token) === index,
  );
  const dedicated = headers.get('x-xhs-operator-token')?.trim();
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = dedicated || bearer;
  if (configuredTokens.length === 0) return 'not_configured';
  if (!supplied) return 'not_supplied';
  const right = Buffer.from(supplied);
  return configuredTokens.some((token) => {
    const left = Buffer.from(token);
    return left.length === right.length && timingSafeEqual(left, right);
  })
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

export async function requireXhsOperatorIdentity(
  request: Pick<Request, 'headers'>,
): Promise<{ identity: string } | { response: NextResponse }> {
  const tokenCheck = checkOperatorToken(request.headers);
  if (tokenCheck === 'authorized') {
    return { identity: 'authenticated-xhs-operator-token' };
  }
  try {
    const access = await validateCloudflareAccessRequest(request);
    return { identity: access.email };
  } catch (error) {
    console.warn(
      'XHS operator access denied:',
      error instanceof Error ? error.message : 'Unknown validation error',
    );
    return {
      response: NextResponse.json(
        { error: 'Unauthorized', code: 'XHS_OPERATOR_AUTH_' + tokenCheck.toUpperCase() },
        { status: 401, headers: { 'X-XHS-Auth-Reason': tokenCheck } },
      ),
    };
  }
}

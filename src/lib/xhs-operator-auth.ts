import { NextResponse } from 'next/server';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';

export async function requireXhsOperator(
  request: Pick<Request, 'headers'>,
): Promise<NextResponse | null> {
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

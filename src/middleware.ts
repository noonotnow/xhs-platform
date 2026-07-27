import { NextRequest, NextResponse } from 'next/server';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';

export async function middleware(request: NextRequest) {
  try {
    await validateCloudflareAccessRequest(request);
    return NextResponse.next();
  } catch {
    return new NextResponse('Unauthorized', { status: 401 });
  }
}

export const config = {
  matcher: ['/admin/:path*'],
};

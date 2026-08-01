import { NextRequest, NextResponse } from 'next/server';
import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';

export async function middleware(request: NextRequest) {
  try {
    await validateCloudflareAccessRequest(request);
    return NextResponse.next();
  } catch {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'CDN-Cache-Control': 'no-store',
        'Vercel-CDN-Cache-Control': 'no-store',
      },
    });
  }
}

export const config = {
  matcher: ['/admin/:path*'],
};

import { NextRequest, NextResponse } from 'next/server';
    import { validateCloudflareAccessRequest } from '@/lib/cloudflare-access';

    const MACHINE_API_PREFIXES = [
    '/admin/api/local-publish-jobs',
    '/admin/api/rednote-publish-attempts',
    '/admin/api/manual-reconciliations',
    ];

    function isMachineApi(pathname: string) {
    return MACHINE_API_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
    );
    }

    export async function middleware(request: NextRequest) {
    if (isMachineApi(request.nextUrl.pathname)) {
      return NextResponse.next();
    }
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
    
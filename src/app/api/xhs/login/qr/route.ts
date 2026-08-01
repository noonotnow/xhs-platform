import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import {
  getQRCode,
  XhsMicroserviceHttpError,
} from '@/lib/xhs-microservice';
import {
  canonicalCreatorQrUrl,
  UnsupportedCreatorQrError,
} from '@/lib/xhs-qr';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) return unauthorized;
  try {
    const qr = await getQRCode();
    return NextResponse.json({
      ...qr,
      url: canonicalCreatorQrUrl(qr.url),
    });
  } catch (e: unknown) {
    const detail = e instanceof XhsMicroserviceHttpError
      ? e.detail
      : e instanceof UnsupportedCreatorQrError
        ? e.message
        : 'Unable to start normal-account Rednote QR login.';
    return NextResponse.json(
      { detail },
      {
        status: e instanceof XhsMicroserviceHttpError ? e.status : 502,
      },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { runDueRednoteSweeps } from '@/lib/rednote-sweeps';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ runs: await runDueRednoteSweeps() });
}

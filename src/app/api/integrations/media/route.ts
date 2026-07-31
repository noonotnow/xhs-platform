import { NextRequest } from 'next/server';
import {
  handleMediaPreflight,
  handleMediaUpload,
} from '@/lib/integration-media';

export async function OPTIONS(request: NextRequest) {
  return handleMediaPreflight(request);
}

export async function POST(request: NextRequest) {
  return handleMediaUpload(request);
}

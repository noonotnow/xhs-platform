import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import { publishNote, uploadImage } from '@/lib/xhs-microservice';

export async function POST(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    const { title, desc, image_urls, files: preUploadedFiles, post_time, topic_keywords, is_private } = body;

    if (!title || !desc) {
      return NextResponse.json({ error: 'title and desc are required' }, { status: 400 });
    }

    // Use pre-uploaded filepaths if provided, otherwise download from URLs
    const files: string[] = [];
    if (preUploadedFiles && preUploadedFiles.length > 0) {
      files.push(...preUploadedFiles);
    } else if (image_urls && image_urls.length > 0) {
      for (const url of image_urls) {
        const imgRes = await fetch(url);
        if (!imgRes.ok) throw new Error(`Failed to fetch image: ${url}`);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const filename = url.split('/').pop() || 'image.jpg';
        const uploaded = await uploadImage(buffer, filename);
        files.push(uploaded.filepath);
      }
    }

    if (files.length === 0) {
      return NextResponse.json({ error: 'At least one image is required for XHS posts' }, { status: 400 });
    }

    const result = await publishNote({
      title,
      desc,
      files,
      post_time,
      topic_keywords: topic_keywords || [],
      is_private: is_private || false,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (e: unknown) {
    console.error('XHS publish error:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

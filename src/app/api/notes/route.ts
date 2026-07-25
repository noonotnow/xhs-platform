import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { content, image_url } = body;

    if (!content || content.trim().length === 0) {
      return NextResponse.json(
        { error: 'Content is required' },
        { status: 400 }
      );
    }

    const result = await sql`
      INSERT INTO notes (user_id, content, image_url)
      VALUES (${user.userId}, ${content}, ${image_url || null})
      RETURNING id, content, image_url, created_at
    `;

    const note = result.rows[0];

    return NextResponse.json(
      {
        id: note.id,
        content: note.content,
        image_url: note.image_url,
        created_at: note.created_at,
        url: `/notes/${note.id}`,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Create note error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20')));
    const offset = (page - 1) * limit;

    const notes = await sql`
      SELECT n.id, n.content, n.image_url, n.created_at,
             u.id as user_id, u.name as user_name, u.avatar_url
      FROM notes n
      JOIN users u ON n.user_id = u.id
      WHERE n.deleted_at IS NULL
      ORDER BY n.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countResult = await sql`
      SELECT COUNT(*) as total FROM notes WHERE deleted_at IS NULL
    `;
    const total = parseInt(countResult.rows[0].total);

    return NextResponse.json({
      notes: notes.rows.map((row) => ({
        id: row.id,
        content: row.content,
        image_url: row.image_url,
        created_at: row.created_at,
        user: {
          id: row.user_id,
          name: row.user_name,
          avatar_url: row.avatar_url,
        },
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('List notes error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

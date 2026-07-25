import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;

    const result = await sql`
      SELECT n.id, n.content, n.image_url, n.created_at, n.updated_at,
             u.id as user_id, u.name as user_name, u.avatar_url
      FROM notes n
      JOIN users u ON n.user_id = u.id
      WHERE n.id = ${id} AND n.deleted_at IS NULL
    `;

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 });
    }

    const row = result.rows[0];

    return NextResponse.json({
      id: row.id,
      content: row.content,
      image_url: row.image_url,
      created_at: row.created_at,
      updated_at: row.updated_at,
      user: {
        id: row.user_id,
        name: row.user_name,
        avatar_url: row.avatar_url,
      },
    });
  } catch (error) {
    console.error('Get note error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

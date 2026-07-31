CREATE TABLE IF NOT EXISTS xhs_publish_receipts (
  notion_page_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('publishing', 'published')),
  note_id TEXT,
  share_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE plan_operator_scheduled_posts
  ADD COLUMN IF NOT EXISTS stable_link_captured_at TIMESTAMP WITH TIME ZONE;

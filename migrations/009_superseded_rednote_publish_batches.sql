ALTER TABLE rednote_publish_batches
  DROP CONSTRAINT IF EXISTS rednote_publish_batches_status_check;

ALTER TABLE rednote_publish_batches
  ADD CONSTRAINT rednote_publish_batches_status_check
  CHECK (status IN (
    'pending_approval', 'approved', 'partially_approved', 'superseded'
  ));

ALTER TABLE rednote_publish_batches
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE rednote_publish_batches
  ADD COLUMN IF NOT EXISTS superseded_by_batch_id UUID;

ALTER TABLE rednote_publish_batches
  DROP CONSTRAINT IF EXISTS rednote_publish_batches_superseded_by_batch_id_fkey;

ALTER TABLE rednote_publish_batches
  ADD CONSTRAINT rednote_publish_batches_superseded_by_batch_id_fkey
  FOREIGN KEY (superseded_by_batch_id)
  REFERENCES rednote_publish_batches(id)
  ON DELETE RESTRICT;

ALTER TABLE rednote_publish_batches
  DROP CONSTRAINT IF EXISTS rednote_publish_batches_kind_check;

ALTER TABLE rednote_publish_batches
  ADD CONSTRAINT rednote_publish_batches_kind_check
  CHECK (kind IN ('weekly', 'catch_up', 'bootstrap', 'on_demand'));

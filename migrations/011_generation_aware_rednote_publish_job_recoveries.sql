ALTER TABLE rednote_publish_job_recoveries
  DROP CONSTRAINT rednote_publish_job_recoveries_local_publish_job_id_key,
  DROP CONSTRAINT rednote_publish_job_recoveries_batch_item_id_key;

ALTER TABLE rednote_publish_job_recoveries
  ADD CONSTRAINT rednote_publish_job_recoveries_job_generation_key
    UNIQUE (local_publish_job_id, prior_claim_attempts),
  ADD CONSTRAINT rednote_publish_job_recoveries_item_generation_key
    UNIQUE (batch_item_id, prior_claim_attempts);

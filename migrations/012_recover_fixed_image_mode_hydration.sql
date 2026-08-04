ALTER TABLE rednote_publish_job_recoveries
  DROP CONSTRAINT rednote_publish_job_recoveries_prior_error_code_check;

ALTER TABLE rednote_publish_job_recoveries
  ADD CONSTRAINT rednote_publish_job_recoveries_prior_error_code_check
    CHECK (
      prior_error_code IN (
        'BOUNDED_BATCH_BYPASS_DISABLED',
        'AMBIGUOUS_CREATOR_UI'
      )
    );

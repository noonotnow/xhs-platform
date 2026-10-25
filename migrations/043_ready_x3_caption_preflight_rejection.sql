-- Recognize the second exact worker preflight rejection, not arbitrary
-- STAGED_FORM_CHANGED failures. Preserve all receipt, lifecycle, identity,
-- source-lock, immutable-packet, future-slot and evidence guards unchanged.
-- The consumed terminal generation is never reactivated or erased.
DO $migration$
DECLARE
  signature TEXT;
  definition TEXT;
  needle TEXT := 'job.error_message=''Creator is no longer showing the staged publish form''';
  replacement TEXT := 'job.error_message IN (
    ''Creator is no longer showing the staged publish form'',
    ''Creator form no longer matches the staged title, caption, and tags''
  )';
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'recover_ready_x3_rejected_form(text,uuid,uuid,text,text,text,timestamp with time zone,text)',
    'rednote_ready_x3_pre_submit_rejection_is_proven(text,uuid,uuid)'
  ] LOOP
    SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
    IF (length(definition) - length(replace(definition,needle,''))) / length(needle) <> 1 THEN
      RAISE EXCEPTION 'Expected exactly one narrow preflight-message guard in %',signature;
    END IF;
    EXECUTE replace(definition,needle,replacement);
  END LOOP;
END;
$migration$;

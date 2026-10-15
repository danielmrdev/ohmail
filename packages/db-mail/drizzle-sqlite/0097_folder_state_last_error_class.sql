-- 0097_folder_state_last_error_class — the error class.
--
-- The entry's CHECK on the column is not carried, for `0091.noop`'s reason: it is declared in
-- the migration and not on the Postgres twin, so this journal cannot carry it alone.

ALTER TABLE "folder_state" ADD COLUMN "last_error_class" text;

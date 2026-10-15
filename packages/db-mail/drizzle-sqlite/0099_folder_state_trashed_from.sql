-- 0099_folder_state_trashed_from — where a trashed message came from.

ALTER TABLE "folder_state" ADD COLUMN "trashed_from" text;

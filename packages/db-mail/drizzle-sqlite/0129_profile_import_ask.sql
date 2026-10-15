-- 0129_profile_import_ask — a press the request could not finish, the pg columns' twin.
--
-- Carried rather than noop'd: the phone's standalone store runs the same import through the same
-- row. The timestamp is epoch milliseconds, as every stamp on this twin. Closed at the writer.

ALTER TABLE "mailboxes" ADD COLUMN "profile_import_ask_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "profile_import_ask_at" integer;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "profile_import_ask_outcome" text;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "profile_import_ask_reason" text;

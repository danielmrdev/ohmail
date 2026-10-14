-- 0148_messages_sender_check — the identity fact on the device store; the pg columns' twins.
--
-- The closed set is IMMUTABLE (`closed-sets.ts`), so its CHECK rides the column on this store too,
-- in the column-constraint form an ADD COLUMN takes. The partial index serves the device's own
-- backfill.

ALTER TABLE "messages" ADD COLUMN "sender_check" text CONSTRAINT "messages_sender_check_closed" CHECK ("sender_check" in ('none', 'impersonation'));
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_check_brand" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "source" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_sender_check_owed_idx" ON "messages" ("account_id", "id") WHERE "sender_check" IS NULL;

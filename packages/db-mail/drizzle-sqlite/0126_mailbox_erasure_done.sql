-- 0126_mailbox_erasure_done — when a mailbox's erasure finished, `erased_at`'s second half.
--
-- Carried rather than noop'd, for 0111's reason: the column is on the shared twin, so a device
-- whose `mailboxes` lacks it reads through a schema that no longer matches and fails at the first
-- query. `integer` here and `timestamptz` on the server. Backfilled for 0126's reason: every stamp
-- before it was written in the same transaction as the whole sweep.

ALTER TABLE "mailboxes" ADD COLUMN "erasure_done_at" integer;
--> statement-breakpoint
UPDATE "mailboxes" SET "erasure_done_at" = "erased_at"
  WHERE "erased_at" IS NOT NULL AND "erasure_done_at" IS NULL;

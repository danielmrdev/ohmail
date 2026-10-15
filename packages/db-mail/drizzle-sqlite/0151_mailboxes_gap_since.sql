-- 0151_mailboxes_gap_since — the gap window and the offer made from it on the device store; the pg
-- columns' twins, epoch milliseconds like every instant on this store.

ALTER TABLE "mailboxes" ADD COLUMN "gap_since" integer;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "gap_letters" integer;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "gap_pressed_at" integer;

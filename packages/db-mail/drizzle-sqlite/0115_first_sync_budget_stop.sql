-- 0115_first_sync_budget_stop — where the first sync stopped.
--
-- Carried rather than noop'd: the phone's standalone store runs the same sync pass through the
-- same cursor, so a device whose store lacks these columns cannot resume either. Integers here,
-- as `uidvalidity` and `uidnext` are on this store; NULL is every existing row.

ALTER TABLE "mailbox_folders" ADD COLUMN "budget_stop_uid" integer;--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD COLUMN "budget_stop_uidvalidity" integer;

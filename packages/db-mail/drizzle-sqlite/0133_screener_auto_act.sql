-- 0133_screener_auto_act — the pg columns' twins. Carried rather than noop'd: the local engine runs
-- the act on this store, reads the consent here and writes the refusal on the suggestion row.
-- `integer` here, `timestamptz` on the server. The closed set is immutable, so its CHECK is here too.

ALTER TABLE "account_settings" ADD COLUMN "screener_auto_act_at" integer;
--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD COLUMN "act_refused_at" integer;
--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD COLUMN "act_refusal" text CONSTRAINT "routing_decisions_act_refusal_closed" CHECK ("act_refusal" in ('account_erased', 'not_organizer', 'mailbox_removed', 'store_fault'));

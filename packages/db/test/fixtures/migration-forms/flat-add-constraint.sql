-- The same migration in the flat replayable form — one statement more, and that statement is the
-- whole difference between the two fixtures.
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "probe_value" text;--> statement-breakpoint
ALTER TABLE "account_settings" DROP CONSTRAINT IF EXISTS "probe_value_len";--> statement-breakpoint
ALTER TABLE "account_settings" ADD CONSTRAINT "probe_value_len"
  CHECK ("probe_value" IS NULL OR char_length("probe_value") <= 128);

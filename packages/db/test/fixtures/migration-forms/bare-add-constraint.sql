-- A migration in the form that cannot be applied twice. Not in either journal: it is the
-- positive control for the refusal, so it must keep the defect the rules exist to find.
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "probe_value" text;--> statement-breakpoint
ALTER TABLE "account_settings" ADD CONSTRAINT "probe_value_len"
  CHECK ("probe_value" IS NULL OR char_length("probe_value") <= 128);

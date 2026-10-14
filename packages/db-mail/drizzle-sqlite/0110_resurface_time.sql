-- 0110_resurface_time — the wall clock a person's resurfaced mail comes back at.
--
-- Carried rather than noop'd, for 0109's reason: the column is on the shared twin, so a device
-- whose `account_settings` lacks it reads through a schema that no longer matches and fails at
-- the first query. Text here, as it is on the server — it stores `'HH:MM'`, not an instant.

ALTER TABLE "account_settings" ADD COLUMN "resurface_time" text;

-- 0120_held_release_dismissed — the pg column's twin. `account_settings` is on the shared
-- twin, and the held-releases door SELECTs the column, so a device store without it fails
-- the first read. Plain text, no CHECK: the value is written only by this install's own
-- dismiss door, which bounds it before the write.

ALTER TABLE "account_settings" ADD COLUMN "held_release_dismissed" text;

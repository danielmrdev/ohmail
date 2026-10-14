-- 0113_refresh_consumed_by_attempt — which attempt consumed this refresh token.
--
-- Carried rather than noop'd: the column is on the shared twin, so a device whose
-- `refresh_tokens` lacks it reads through a schema that no longer matches and fails at the first
-- rotation. Text here as on the server — it stores a sha256 digest, never the client's string.

ALTER TABLE "refresh_tokens" ADD COLUMN "consumed_by_attempt" text;

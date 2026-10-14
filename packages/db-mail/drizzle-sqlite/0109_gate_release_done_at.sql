-- 0109_gate_release_done_at — the one-time gate release's per-account marker.
--
-- Carried rather than noop'd, for 0108's reason: the column is on the shared twin, so a device
-- whose store lacks it reads and writes `account_settings` through a schema that no longer
-- matches and fails at the first query. An integer here, as every timestamp on this store is.

ALTER TABLE "account_settings" ADD COLUMN "gate_release_done_at" integer;

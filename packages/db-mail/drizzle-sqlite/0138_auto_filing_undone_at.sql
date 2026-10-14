-- 0138_auto_filing_undone_at — the Screener's automatic filing, put back; the pg column's twin.
--
-- No device runs the auto-apply pass; the column rides here because a standalone door serves the
-- put-back routes, whose move writes it. `integer` here and `timestamptz` on the server.

ALTER TABLE "folder_state" ADD COLUMN "auto_filing_undone_at" integer;

-- 0141_screener_floor_version — the auto-apply pass's floor verdict; the pg column's twin.
--
-- No device runs the auto-apply pass; the column rides here so both stores keep one shape.

ALTER TABLE "folder_state" ADD COLUMN "screener_floor_version" integer;

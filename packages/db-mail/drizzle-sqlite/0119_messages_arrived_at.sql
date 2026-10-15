-- 0119_messages_arrived_at — the honest arrival (IMAP INTERNALDATE), the pg column's twin.
-- Carried rather than noop'd: `messages` is on the shared twin, and a device whose schema lacks
-- the column fails at the first query through it. `integer` here, `timestamptz` on the server,
-- as every instant on this twin is. NULL for every existing row — no backfill, so nothing
-- re-sorts: an arrival nobody recorded stays unrecorded and the header keeps deciding.

ALTER TABLE "messages" ADD COLUMN "arrived_at" integer;

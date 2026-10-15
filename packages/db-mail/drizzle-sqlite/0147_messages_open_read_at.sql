-- messages.open_read_at — the open read (a message read in ohmail while it was the open row),
-- the pg column's twin. Carried: `messages` is on the shared twin, and a device whose schema lacks
-- the column fails at the first query through it. `integer` here, `timestamptz` on the server.
-- NULL for every existing row — no backfill, so nothing re-sorts.

ALTER TABLE "messages" ADD COLUMN "open_read_at" integer;

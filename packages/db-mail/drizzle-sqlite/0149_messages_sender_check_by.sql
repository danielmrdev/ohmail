-- 0149_messages_sender_check_by — which writer gave a message its identity fact; the pg column's twin.
--
-- The closed set is IMMUTABLE (`closed-sets.ts`), so its CHECK rides the column on this store too,
-- in the column-constraint form an ADD COLUMN takes.

ALTER TABLE "messages" ADD COLUMN "sender_check_by" text CONSTRAINT "messages_sender_check_by_closed" CHECK ("sender_check_by" in ('ingest', 'backfill'));

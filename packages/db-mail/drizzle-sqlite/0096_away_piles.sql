-- 0096_away_piles — the pile list, and the undeliverable stamp.
--
-- `piles` is a Postgres `text[]` on the server and JSON text here, which is the ruled mapping
-- (SQLiteTextJson); the DEFAULT is the same one member, spelled as JSON.
--
-- The entry's CHECK on `piles` is not carried — see `0101.noop`, which widens that same CHECK
-- and explains where the closed set lives on this store.

ALTER TABLE "away_responders" ADD COLUMN "piles" text NOT NULL DEFAULT '["INBOX"]';--> statement-breakpoint
ALTER TABLE "away_sender_state" ADD COLUMN "undeliverable_at" integer;

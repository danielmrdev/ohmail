-- 0151_mailboxes_gap_since — the window in which a reader saw nothing organize its mailbox, and the
-- offer made from it.
--
-- mailboxes.gap_since: set by the reader's own look when it finds no live organizer (coalesce, so
-- the earliest instant stands); cleared by a look that finds one, by a stand-down, and by the
-- person's answer. NULL = no window open. gap_letters: how many letters in that window the
-- person's rules would file, counted once after this install starts organizing; shown to the
-- person, never acted on alone. gap_pressed_at: the person pressed "File them" for that count.
-- Nullable, no default and no backfill; nothing granted to staff; each statement survives a second
-- application. ROLLBACK: drop the three columns.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "gap_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "gap_letters" integer;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "gap_pressed_at" timestamp with time zone;

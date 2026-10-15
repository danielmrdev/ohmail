-- 0130_mailbox_sync_soft_states — the pg column's twin.
--
-- Carried for 0108's reason: the column is on the shared twin. The CHECK half has no form here —
-- SQLite refuses the widenable sets at the write door (`closed-sets.ts`), which reads the constant.

ALTER TABLE "mailboxes" ADD COLUMN "sync_progress_at" integer;

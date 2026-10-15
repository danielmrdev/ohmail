-- 0111_mailbox_erased_at — the MAILBOX erasure fence's stamp, `accounts.erased_at`'s twin.
--
-- Carried rather than noop'd, for 0110's reason: the column is on the shared twin, so a device
-- whose `mailboxes` lacks it reads through a schema that no longer matches and fails at the first
-- query. `integer` here and `timestamptz` on the server, as every instant on this twin is.
--
-- NULL for a live mailbox and for one removed WITHOUT erasure; nothing is backfilled, because a
-- stamp nobody's erasure wrote would refuse writes against a mailbox whose mail is still there.

ALTER TABLE "mailboxes" ADD COLUMN "erased_at" integer;

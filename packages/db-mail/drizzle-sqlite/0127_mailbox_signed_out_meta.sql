-- 0127_mailbox_signed_out_meta — where a signed-out mailbox lives, the pg column's twin.
--
-- Carried rather than noop'd for 0108's reason: the column is on the shared twin, so a device
-- whose `mailboxes` lacks it reads through a schema that no longer matches. JSON text here.

ALTER TABLE "mailboxes" ADD COLUMN "signed_out_meta" text;

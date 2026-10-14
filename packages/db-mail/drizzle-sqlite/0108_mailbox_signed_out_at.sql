-- 0108_mailbox_signed_out_at — the sign-out fence's durable stamp.
--
-- Carried rather than noop'd: the column is on the shared twin, so a device whose store lacks it
-- reads and writes `mailboxes` through a schema that no longer matches and fails at the first
-- query. An integer here, as every timestamp on this store is.

ALTER TABLE "mailboxes" ADD COLUMN "signed_out_at" integer;

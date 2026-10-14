-- 0135_organizer_parked_at — when the wall stood this mailbox down, the pg column's twin.
--
-- Carried rather than noop'd, for 0126's reason: the column is on the shared twin, so a device
-- whose `mailboxes` lacks it reads through a schema that no longer matches. `integer` here and
-- `timestamptz` on the server. No device writes it: only the hosted worker parks an account.

ALTER TABLE "mailboxes" ADD COLUMN "organizer_parked_at" integer;

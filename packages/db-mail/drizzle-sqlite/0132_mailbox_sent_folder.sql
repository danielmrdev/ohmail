-- 0132_mailbox_sent_folder — the mailbox's own Sent folder, the pg column's twin.
-- Carried rather than noop'd: the phone's engine runs the attach that writes it and the
-- correspondent read that admits it. NULL for every existing mailbox until its next attach.

ALTER TABLE "mailboxes" ADD COLUMN "sent_folder" text;

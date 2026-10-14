-- 0121_release_refusal — why a standing stop has not finished (mail 0121).
--
-- Carried rather than noop'd: the phone's standalone store runs the same release pass through
-- the same row, so a device whose store lacks the column cannot say the sibling-lapse sentence
-- either. NULL is every existing row; the writer's value set is closed ('sibling_lapse').

ALTER TABLE "mailboxes" ADD COLUMN "release_refusal" text;

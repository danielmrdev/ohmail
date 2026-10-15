-- 0122_change_log_retention — the retention floor's twin. Carried rather than noop'd:
-- `account_sync_state` is on the shared twin, and `seqBounds` now reads the floor on every
-- resuming `/sync`, so a device whose schema lacks the column fails at the first query through
-- it. No retention pass runs on a device — the floor rests at 0 forever there — but every
-- reader's arithmetic stays identical across dialects. The pg side's prune index is not mirrored:
-- no device prunes, and the server builds it outside the journal.

ALTER TABLE "account_sync_state" ADD COLUMN "pruned_through_seq" integer NOT NULL DEFAULT 0;

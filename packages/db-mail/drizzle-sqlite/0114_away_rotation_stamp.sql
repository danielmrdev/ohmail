-- 0114_away_rotation_stamp — the away responder's rotation stamp.
--
-- Carried rather than noop'd: the column is on the shared twin and the pass reads it on this
-- store too, so a device whose store lacks it fails at the probe. An integer here, as every
-- timestamp on this store is; 0 is the never-walked sentinel `to_timestamp(0)` is on the server.

ALTER TABLE "away_responders" ADD COLUMN "last_considered_at" integer NOT NULL DEFAULT 0;

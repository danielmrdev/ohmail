-- 0107_release_held_at — the press that releases mail held at the screening gate.
--
-- Carried rather than noop'd: the column is on the shared twin, so a device whose store lacks it
-- reads and writes `rules` through a schema that no longer matches and fails at the first query.
-- An integer here, as every timestamp on this store is.

ALTER TABLE "rules" ADD COLUMN "release_held_at" integer;

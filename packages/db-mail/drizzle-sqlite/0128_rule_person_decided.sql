-- 0128_rule_person_decided — who made a rule's decision, the pg column's twin.
-- Carried rather than noop'd: `rules` is on the shared twin and the unsubscribe drain reads the
-- column on every store. `integer` here, `timestamptz` on the server. NULL for every existing rule.

ALTER TABLE "rules" ADD COLUMN "person_decided_at" integer;

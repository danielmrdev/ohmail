-- 0153_rule_revoke_keeps_its_decisions — a rule that filed mail can be revoked. 0118 keyed
-- `routing_decisions.matched_rule_id` to `rules (id, account_id)` with no delete action, and the gap
-- catch-up writes that column for every letter it files, so deleting such a rule failed 23503: the
-- revoke answered 500 and the rule kept filing. The decision row records a move that happened and
-- stays; only its pointer to the gone rule is dropped. SET NULL names its column, because the bare
-- form would null the NOT NULL `account_id` too (0118's own argument). Drop-then-add under the
-- existing name, so a second application is a no-op; NOT VALID, as the lock-cost rule asks of a
-- growth table (every existing row satisfied the old key; its VALIDATE ships in a later release).
-- ROLLBACK: the same pair without the ON DELETE clause.

ALTER TABLE "routing_decisions" DROP CONSTRAINT IF EXISTS "routing_decisions_matched_rule_id_account_fk";
--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_matched_rule_id_account_fk" FOREIGN KEY ("matched_rule_id", "account_id") REFERENCES "rules" ("id", "account_id") ON DELETE SET NULL ("matched_rule_id") NOT VALID;

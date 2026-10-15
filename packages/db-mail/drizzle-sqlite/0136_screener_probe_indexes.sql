-- 0136_screener_probe_indexes — the three indexes the pg entry adds, carried as they are.
--
-- The twins stay one schema, and a device asks two of these questions too: a Screener decision
-- reads rules through the same key (`ruleNamesSenderSql`), and a reply draft or an approval is
-- looked up by message. SQLite takes a partial index only where the query implies its WHERE term:
-- `x = ?` implies `x IS NOT NULL`, and the readers that spell `enabled` bare use the rules index.

CREATE INDEX IF NOT EXISTS "rules_account_match_key_idx" ON "rules" ("account_id", trim(lower("match"))) WHERE "enabled";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_account_message_idx" ON "approvals" ("account_id", "message_id") WHERE "message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drafts_account_reply_idx" ON "drafts" ("account_id", "in_reply_to_message_id") WHERE "in_reply_to_message_id" IS NOT NULL;

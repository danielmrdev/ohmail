-- 0144_rule_person_decided_backfill — the pg entry's classes and its index, on this store.
--
-- A device decides senders too (the Screener, "always allow", the HEY import), so its rules carry
-- the same history and take the same backfill; the statements are the pg ones with this store's
-- index spelling, in the pg order (the index last). The second arm's UPDATE … FROM needs SQLite
-- 3.33, under this store's 3.43 floor. Screen-outs are not stamped. Idempotent: each WHERE empties
-- in one run.

UPDATE "rules" SET "provenance" = 'manual', "person_decided_at" = "created_at"
 WHERE "kind" = 'sender' AND "provenance" = 'promoted' AND "person_decided_at" IS NULL
   AND "subject_contains" IS NULL AND "body_contains" IS NULL AND "destination" = 'INBOX'
   AND NOT EXISTS (SELECT 1 FROM "learning_signals" s
                    WHERE s."account_id" = "rules"."account_id" AND s."kind" = 'screener'
                      AND s."destination" = 'INBOX'
                      AND lower(s."sender_address") = trim(lower("rules"."match")))
   AND NOT EXISTS (SELECT 1 FROM "graduations" g
                    WHERE g."account_id" = "rules"."account_id" AND g."action" = 'route'
                      AND g."graduated_at" IS NOT NULL
                      AND g."pattern_key" = 'sender:' || trim(lower("rules"."match")) || '→INBOX');--> statement-breakpoint
UPDATE "rules" SET "provenance" = 'manual', "person_decided_at" = "rules"."created_at"
  FROM (SELECT s."account_id", lower(s."sender_address") AS "sender",
               max(CASE WHEN s."destination" IN ('ohmail/Quarantine', 'ohmail/Screened')
                         AND s."triggering_action_id" NOT LIKE 'screener:auto:%' THEN s."created_at" END) AS "last_out",
               max(CASE WHEN s."destination" = 'INBOX'
                         AND s."triggering_action_id" LIKE 'screener:auto:%' THEN s."created_at" END) AS "last_admit"
          FROM "learning_signals" s
         WHERE s."kind" = 'screener'
         GROUP BY s."account_id", lower(s."sender_address")) AS "o"
 WHERE "o"."account_id" = "rules"."account_id" AND "o"."sender" = trim(lower("rules"."match"))
   AND "rules"."kind" = 'sender' AND "rules"."provenance" = 'promoted' AND "rules"."person_decided_at" IS NULL
   AND "rules"."subject_contains" IS NULL AND "rules"."body_contains" IS NULL AND "rules"."destination" = 'INBOX'
   AND "rules"."created_at" > "o"."last_out"
   AND ("o"."last_admit" IS NULL OR "o"."last_admit" < "o"."last_out")
   AND NOT EXISTS (SELECT 1 FROM "graduations" g
                    WHERE g."account_id" = "rules"."account_id" AND g."action" = 'route'
                      AND g."pattern_key" = 'sender:' || "o"."sender" || '→INBOX'
                      AND g."graduated_at" >= "o"."last_out");--> statement-breakpoint
UPDATE "rules" SET "person_decided_at" = "created_at"
 WHERE "kind" = 'sender' AND "provenance" = 'promoted' AND "person_decided_at" IS NULL
   AND "subject_contains" IS NULL AND "body_contains" IS NULL
   AND "destination" IN ('INBOX', 'ohmail/News', 'ohmail/Reads', 'ohmail/Receipts')
   AND EXISTS (SELECT 1 FROM "learning_signals" s
                WHERE s."account_id" = "rules"."account_id" AND s."kind" = 'screener'
                  AND lower(s."sender_address") = trim(lower("rules"."match"))
                  AND s."triggering_action_id" NOT LIKE 'screener:auto:%'
                  AND (CASE WHEN s."destination" = 'ohmail/Reads' THEN 'ohmail/News' ELSE s."destination" END)
                    = (CASE WHEN "rules"."destination" = 'ohmail/Reads' THEN 'ohmail/News' ELSE "rules"."destination" END));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rules_account_key_idx" ON "rules" ("account_id", trim(lower("match")));

-- 0095_outbound_send_resolution — the two resolution columns, and the one rebuild in this journal.
--
-- A rebuild rather than appends because the entry makes `draft_id` NULLABLE and turns its
-- reference into ON DELETE SET NULL, and SQLite can change neither by ALTER. `resolved_by` and
-- `resolved_at` are the entry's own new columns and land in the rebuilt table rather than as a
-- separate append, which is what keeps this to one table swap.
--
-- The INSERT lists its columns on both sides: a bare `INSERT INTO … SELECT *` would bind the
-- old table's column ORDER to the new table's, and the new table has two more.

CREATE TABLE "outbound_sends__0095" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "draft_id" text,
  "minted_message_id" text NOT NULL,
  "provider_message_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "sent_at" integer,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "resolved_by" text,
  "resolved_at" integer,
  CONSTRAINT "outbound_sends_account_id_idempotency_key_unique" UNIQUE ("account_id", "idempotency_key"),
  FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE SET NULL
);--> statement-breakpoint
INSERT INTO "outbound_sends__0095"
  ("id", "account_id", "idempotency_key", "draft_id", "minted_message_id",
   "provider_message_id", "status", "sent_at", "created_at")
SELECT "id", "account_id", "idempotency_key", "draft_id", "minted_message_id",
       "provider_message_id", "status", "sent_at", "created_at"
  FROM "outbound_sends";--> statement-breakpoint
DROP TABLE "outbound_sends";--> statement-breakpoint
ALTER TABLE "outbound_sends__0095" RENAME TO "outbound_sends";

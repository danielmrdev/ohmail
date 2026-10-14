-- 0125_message_search — the search document's twin, WITHOUT the two word vectors: this store's word index is
-- FTS5 over the rows themselves (0001's `messages_fts` / `message_bodies_fts`), so the row here
-- carries the substring corpus (`terms`: senders, recipients, attachment names) and the
-- provenance the backfill's progress reads. The History order index is the server's, with the
-- store's own null order (NULLs sort last under DESC here). The completion stamp as on the server.

CREATE TABLE IF NOT EXISTS "message_search" (
  "message_id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "terms" text NOT NULL DEFAULT '',
  "source" text NOT NULL,
  "built_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "message_search_source_closed" CHECK ("source" IN ('text', 'html', 'headers_only')),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_search_account_idx" ON "message_search" ("account_id", "message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_account_msg_order_idx" ON "messages" ("account_id", "date" DESC, "id" DESC) WHERE "deleted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN "search_index_built_at" integer;

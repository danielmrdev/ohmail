-- 0116_unsub_drain_cursor — the drain's per-message marker, its window cursor and the window index.
--
-- Carried rather than noop'd: the standalone phone runs the same drain over this store, so both
-- tables and the index are the same decision here. Integers for the timestamps, as every timestamp
-- on this store is; text for the ids.

CREATE TABLE IF NOT EXISTS "unsubscribe_examined" (
	"message_id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY ("message_id") REFERENCES "messages"("id"),
	FOREIGN KEY ("record_id") REFERENCES "unsubscribe_records"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unsubscribe_examined_record_idx" ON "unsubscribe_examined" ("record_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "unsubscribe_drain_state" (
	"pass" text PRIMARY KEY NOT NULL,
	"cursor_at" integer,
	"cursor_message_id" text,
	"updated_at" integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	CONSTRAINT "unsubscribe_drain_state_cursor_pair" CHECK (("cursor_at" IS NULL) = ("cursor_message_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folder_state_desired_updated_idx" ON "folder_state" ("desired_folder","updated_at","message_id");

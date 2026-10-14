-- 0117_junk_rescues — the junk rescue's desired state, the device half.
--
-- A REAL twin and not a `.noop`: the standalone phone serves the screener routes through its own
-- local door, so the press records a row here and the engine's own sync cycle drains it. The
-- status CHECK is inline because SQLite has no `ALTER … DROP CONSTRAINT`, and it may be here at
-- all because the set is IMMUTABLE (`closed-sets.ts`). The error-class CHECK is deliberately NOT
-- here: that set widens with the response codes the worker learns to name, and a widenable set on
-- this store is a fifty-column rebuild for one word.

CREATE TABLE "junk_rescues" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL REFERENCES "mailboxes"("id"),
  "folder" text NOT NULL,
  "uidvalidity" integer NOT NULL,
  "uid" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" integer,
  "last_error_class" text,
  "requested_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "junk_rescues_locator_uq" UNIQUE ("mailbox_id", "folder", "uidvalidity", "uid"),
  CONSTRAINT "junk_rescues_status_closed" CHECK ("status" in ('pending', 'refused'))
);--> statement-breakpoint

CREATE INDEX "junk_rescues_due_idx" ON "junk_rescues" ("mailbox_id","next_attempt_at") WHERE "status" = 'pending';

-- 0094_request_kinds_moves_profile — the profile mirror and its index.
--
-- The shared entry ALSO rewrites two CHECKs on `organizer_requests` (its kinds and its refusal
-- reasons). Neither is carried, for the reason `0091.noop` sets out at length: those CHECKs live
-- in the migration and are not declared on the Postgres twin, so declaring them here alone
-- fails `schema-twin-parity`, and declaring them on both twins is an edit to the shared server
-- schema that this journal is not the place to make.

CREATE TABLE "mailbox_profile_mirror" (
  "mailbox_id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "uidvalidity" integer,
  "uid" integer,
  "doc" text NOT NULL,
  "read_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);--> statement-breakpoint
CREATE INDEX "mailbox_profile_mirror_account_idx" ON "mailbox_profile_mirror" ("account_id");

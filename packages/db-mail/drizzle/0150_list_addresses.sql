-- 0150_list_addresses — the addresses a mailing list posts as, and the backfill's stamp.
--
-- list_addresses: one row per (account, address) that a stored inbound message's List-Post names,
-- unless that message failed authentication; written by ingest and once by the backfill, deleted
-- only with the account. The primary key leads with account_id and is the upsert's conflict
-- target. consented_brands: the brands a person's own press admitted under the address; a consent
-- reset empties it and keeps the row. account_settings.list_addresses_scanned_at: the backfill's
-- stamp, NULL = not scanned. No backfill here, nothing granted to staff, and both statements
-- survive a second application. ROLLBACK: drop the column, then the table.

CREATE TABLE IF NOT EXISTS "list_addresses" (
  "account_id" uuid NOT NULL,
  "address" text NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consented_brands" jsonb DEFAULT '[]'::jsonb NOT NULL,
  CONSTRAINT "list_addresses_account_id_address_pk" PRIMARY KEY ("account_id", "address")
);
--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "list_addresses_scanned_at" timestamp with time zone;

-- 0150_list_addresses — the addresses a mailing list posts as, on the device store; the pg twins.
--
-- The backfill's stamp is the column's twin, epoch milliseconds like every instant on this store.

CREATE TABLE IF NOT EXISTS "list_addresses" (
  "account_id" text NOT NULL,
  "address" text NOT NULL,
  "first_seen_at" integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
  "last_seen_at" integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
  "consented_brands" text DEFAULT '[]' NOT NULL,
  CONSTRAINT "list_addresses_account_id_address_pk" PRIMARY KEY ("account_id", "address")
);
--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN "list_addresses_scanned_at" integer;

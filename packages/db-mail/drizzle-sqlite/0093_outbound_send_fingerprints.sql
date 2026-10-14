-- 0093_outbound_send_fingerprints — the send-fingerprint table.
--
-- Created BEFORE 0095 rebuilds `outbound_sends`, which is the numeric order and is safe: the
-- child holds no rows on a store this young, and SQLite re-resolves the reference by name after
-- the swap. Measured both ways round on `node:sqlite` before the steps were split apart.
--
-- The hex CHECK is the ruled SQLite spelling of the server's regex — `schema-twin-parity`'s
-- DIALECT_CHECKS records the pair.

CREATE TABLE "outbound_send_fingerprints" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "fingerprint" text NOT NULL,
  "send_id" text NOT NULL REFERENCES "outbound_sends"("id") ON DELETE CASCADE,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "outbound_send_fingerprints_content_uq" UNIQUE ("account_id", "mailbox_id", "fingerprint"),
  CONSTRAINT "outbound_send_fingerprints_hex" CHECK (length("fingerprint") = 64 AND "fingerprint" NOT GLOB '*[^0-9a-f]*')
);

-- The device sibling of the shared 0112. Integer milliseconds here, `timestamptz` there — the
-- store a device carries spells an instant the way every other timestamp column in it is spelled.

ALTER TABLE "idempotency_keys" ADD COLUMN "erased_at" integer;

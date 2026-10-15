-- 0139_messages_arrival_order — the pg entry's arrival index, on this store's epoch milliseconds.
--
-- The same order the device's own list reads and pages by; the expression is byte-equal to the
-- dialect's own text, which is what lets a query spelling it take this index.

CREATE INDEX IF NOT EXISTS "messages_account_arrival_order_idx" ON "messages" ("account_id", (case when "arrived_at" is null then coalesce("date", 0) when "date" is null then "arrived_at" when abs("date" - "arrived_at") <= 172800000 then "date" else "arrived_at" end) DESC, "id" DESC) WHERE "deleted_at" IS NULL;

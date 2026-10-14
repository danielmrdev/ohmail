-- 0137_draft_forward_of — the message a draft forwards, the pg column's twin.
--
-- The key names the message alone, as this store keys `in_reply_to_message_id`; the CHECK rides
-- the added column, so a device refuses a draft that both answers and forwards, as the server does.

ALTER TABLE "drafts" ADD COLUMN "forward_of_message_id" text REFERENCES "messages"("id") CONSTRAINT "drafts_reply_xor_forward" CHECK ("in_reply_to_message_id" IS NULL OR "forward_of_message_id" IS NULL);

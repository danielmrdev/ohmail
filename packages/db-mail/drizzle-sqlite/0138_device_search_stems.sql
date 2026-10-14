-- 0138_device_search_stems — the device's mail word index stems as the server's does.
-- device-only: the server's word index is already stemmed (its `english` text search configuration);
-- only this store's two FTS5 tables read words as typed, so `delivery` never found `deliveries`.
--
-- Both tables and their six triggers are recreated with FTS5's `porter` tokenizer over the same
-- `unicode61` rules, then rebuilt from the rows they index. The knowledge base index is unchanged.
-- Replay-safe: every drop is `IF EXISTS` and a second run rebuilds the same index again.

DROP TRIGGER IF EXISTS messages_fts_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_fts_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_fts_after_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_bodies_fts_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_bodies_fts_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_bodies_fts_after_update;
--> statement-breakpoint
DROP TABLE IF EXISTS messages_fts;
--> statement-breakpoint
DROP TABLE IF EXISTS message_bodies_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_address,
  content='messages',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE message_bodies_fts USING fts5(
  text,
  content='message_bodies',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER messages_fts_after_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_address) VALUES (new.rowid, new.subject, new.from_address);
END;
--> statement-breakpoint
CREATE TRIGGER messages_fts_after_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_address) VALUES ('delete', old.rowid, old.subject, old.from_address);
END;
--> statement-breakpoint
CREATE TRIGGER messages_fts_after_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_address) VALUES ('delete', old.rowid, old.subject, old.from_address);
  INSERT INTO messages_fts(rowid, subject, from_address) VALUES (new.rowid, new.subject, new.from_address);
END;
--> statement-breakpoint
CREATE TRIGGER message_bodies_fts_after_insert AFTER INSERT ON message_bodies BEGIN
  INSERT INTO message_bodies_fts(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER message_bodies_fts_after_delete AFTER DELETE ON message_bodies BEGIN
  INSERT INTO message_bodies_fts(message_bodies_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
--> statement-breakpoint
CREATE TRIGGER message_bodies_fts_after_update AFTER UPDATE ON message_bodies BEGIN
  INSERT INTO message_bodies_fts(message_bodies_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO message_bodies_fts(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
--> statement-breakpoint
INSERT INTO message_bodies_fts(message_bodies_fts) VALUES('rebuild');

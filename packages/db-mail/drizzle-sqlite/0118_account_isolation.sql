-- 0118_account_isolation — the unique indexes the composite keys reference (shared journal 0118).
--
-- The keys themselves do not land here. Adding one is a whole-table rebuild on this store, and a
-- rebuild of a REFERENCED table is not safe inside this migrator: `DROP TABLE` performs an
-- implicit DELETE FROM with foreign keys on, so every ON DELETE CASCADE child loses its rows, and
-- the pragma that would prevent it is a no-op inside the transaction each entry runs in.
--
-- The class is also unrepresentable here: this store holds exactly one account. `ensureLocalWorld`
-- is the only writer of `accounts` a device carries and it is find-or-create, so there is no second
-- account for a row to point at. The indexes land so the two schemas stay one schema.

CREATE UNIQUE INDEX "mailboxes_id_account_uq" ON "mailboxes" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_id_account_uq" ON "messages" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_id_account_uq" ON "threads" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_id_account_uq" ON "contacts" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_id_account_uq" ON "tags" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_id_account_uq" ON "drafts" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_sends_id_account_uq" ON "outbound_sends" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_decisions_id_account_uq" ON "routing_decisions" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_id_account_uq" ON "rules" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_id_account_uq" ON "workflows" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_id_account_uq" ON "users" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_id_account_uq" ON "devices" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_id_account_uq" ON "sessions" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_folders_id_mailbox_uq" ON "mailbox_folders" ("id", "mailbox_id");

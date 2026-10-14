-- The mail schema, as one statement per breakpoint, for the store a device carries.
--
-- Hand-maintained, like every migration in this repository: no generator writes these files and
-- none reads them back. What keeps this in step with the schema declaration is not care but a
-- test — it applies this file to an empty database and compares the result, table by table and
-- column by column, with what the query builder believes the schema to be.
--
-- WHY THE BREAKPOINT MARKERS RATHER THAN SPLITTING ON THE SEMICOLON. The triggers below contain
-- semicolons INSIDE their bodies. A migrator that split on `;` would hand the store half a
-- trigger, and the error it reported would name a syntax problem in SQL nobody wrote. The marker
-- is the only separator that survives a compound statement.
--
-- WHY FULL TEXT IS AN INDEX AND NOT A COLUMN. The server keeps a generated column per searchable
-- table. This store has no equivalent, and materialising the same text into the row would double
-- what a mailbox costs on a phone. An external-content index stores only the postings and reads
-- the row it points at, so the text lives in exactly one place; the three triggers per index are
-- what keep it current, and they are part of the schema rather than something the application
-- remembers to do.

CREATE TABLE "account_settings" (
  "account_id" text PRIMARY KEY NOT NULL,
  "dormancy_days" integer,
  "seed_confirmed_at" integer,
  "seed_confirmed_count" integer NOT NULL DEFAULT 0,
  "seed_declined_count" integer NOT NULL DEFAULT 0,
  "screening_reset_at" integer,
  "auto_suggest_at" integer,
  "ohbox_policy" text,
  "ohbox_bar" text,
  "ohbox_tidy_requested_at" integer,
  "ohbox_tidy_done_at" integer,
  "ohbox_tidy_cursor" text,
  "screener_auto_apply_at" integer,
  "folders_enabled_at" integer,
  "screening_baseline_at" integer,
  "block_remote_images_at" integer,
  "load_tracking_pixels_at" integer,
  "block_auto_unsubscribe_at" integer,
  "locale" text,
  "theme_face" text,
  "onboarding_completed_at" integer,
  "screening_scope" text NOT NULL DEFAULT 'window',
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE "account_storage" (
  "account_id" text PRIMARY KEY NOT NULL,
  "bytes" integer NOT NULL DEFAULT 0,
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "account_storage_bytes_nonneg" CHECK ("bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "account_sync_state" (
  "account_id" text PRIMARY KEY NOT NULL,
  "next_seq" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "accounts" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "name" text NOT NULL DEFAULT '',
  "ai_enabled" integer NOT NULL DEFAULT true,
  "ai_answered_at" integer,
  "erased_at" integer,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "kind" text NOT NULL,
  "message_id" text,
  "routing_decision_id" text,
  "action" text NOT NULL,
  "summary" text NOT NULL DEFAULT '',
  "payload" text,
  "confidence" real,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" integer,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE "attachments" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "message_id" text NOT NULL,
  "filename" text,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL DEFAULT 0,
  "part_id" text,
  "content_id" text,
  "inline" integer NOT NULL DEFAULT false,
  "content_sha256" text,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "action" text NOT NULL,
  "payload" text,
  "inverse" text,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE "away_replies" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "message_id" text NOT NULL,
  "sender" text NOT NULL,
  "outcome" text NOT NULL,
  "reason" text,
  "text_hash" text,
  "minted_message_id" text,
  "decided_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "sent_at" integer
);
--> statement-breakpoint
CREATE TABLE "away_responder_sent" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "sender" text NOT NULL,
  "responder_updated_at" integer NOT NULL,
  "message_id" text,
  "minted_message_id" text,
  "sent_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE "away_responders" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "enabled" integer NOT NULL DEFAULT false,
  "subject" text,
  "body" text,
  "starts_at" integer,
  "ends_at" integer,
  "audience" text NOT NULL DEFAULT 'screened_in',
  "throttle" text NOT NULL DEFAULT 'per_day',
  "enabled_at" integer,
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "away_responders_account_id_unique" UNIQUE ("account_id")
);
--> statement-breakpoint
CREATE TABLE "away_sender_state" (
  "account_id" text NOT NULL,
  "sender" text NOT NULL,
  "last_replied_at" integer NOT NULL,
  "last_text_hash" text NOT NULL,
  CONSTRAINT "away_sender_state_account_id_sender_pk" PRIMARY KEY ("account_id", "sender")
);
--> statement-breakpoint
CREATE TABLE "change_log" (
  "account_id" text NOT NULL,
  "seq" integer NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "op" text NOT NULL,
  "meta" text,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "change_log_account_id_seq_pk" PRIMARY KEY ("account_id", "seq")
);
--> statement-breakpoint
CREATE TABLE "contact_notes" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "contact_id" text NOT NULL,
  "body" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "address" text NOT NULL,
  "name" text,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "contacts_account_id_address_unique" UNIQUE ("account_id", "address")
);
--> statement-breakpoint
CREATE TABLE "devices" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL DEFAULT '',
  "ip" text NOT NULL DEFAULT '',
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "last_seen_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "last_synced_at" integer,
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "thread_id" text,
  "in_reply_to_message_id" text,
  "subject" text NOT NULL DEFAULT '',
  "body" text NOT NULL DEFAULT '',
  "html" text,
  "to" text NOT NULL DEFAULT '[]',
  "cc" text NOT NULL DEFAULT '[]',
  "bcc" text NOT NULL DEFAULT '[]',
  "rationale" text,
  "status" text NOT NULL DEFAULT 'draft',
  "workflow_dedup_key" text,
  "send_at" integer,
  "send_key" text,
  "send_error" text,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "drafts_workflow_dedup_key_unique" UNIQUE ("workflow_dedup_key"),
  FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id"),
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id"),
  FOREIGN KEY ("in_reply_to_message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE TABLE "flag_state" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "message_id" text NOT NULL,
  "desired_seen" integer NOT NULL,
  "observed_seen" integer NOT NULL,
  "last_set_by" text NOT NULL,
  "reconcile_status" text NOT NULL DEFAULT 'pending',
  "conflict" integer NOT NULL DEFAULT false,
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" integer,
  CONSTRAINT "flag_state_message_id_unique" UNIQUE ("message_id"),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE TABLE "folder_ops" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "folder_id" text NOT NULL,
  "op" text NOT NULL,
  "to_folder" text,
  "status" text NOT NULL DEFAULT 'pending',
  "error" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "requested_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "folder_ops_folder_id_unique" UNIQUE ("folder_id"),
  FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id"),
  FOREIGN KEY ("folder_id") REFERENCES "mailbox_folders"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "folder_state" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "message_id" text NOT NULL,
  "desired_folder" text NOT NULL,
  "observed_folder" text NOT NULL,
  "last_set_by" text NOT NULL,
  "reconcile_status" text NOT NULL DEFAULT 'pending',
  "conflict" integer NOT NULL DEFAULT false,
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" integer,
  CONSTRAINT "folder_state_message_id_unique" UNIQUE ("message_id"),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE TABLE "graduations" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "pattern_key" text NOT NULL,
  "action" text NOT NULL DEFAULT 'route',
  "positives" integer NOT NULL DEFAULT 0,
  "negatives" integer NOT NULL DEFAULT 0,
  "graduated" integer NOT NULL DEFAULT false,
  "graduated_at" integer,
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "graduations_account_id_pattern_key_action_unique" UNIQUE ("account_id", "pattern_key", "action")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
  "account_id" text NOT NULL,
  "key" text NOT NULL,
  "request_hash" text NOT NULL,
  "response_status" integer NOT NULL,
  "response_json" text NOT NULL,
  "seq" integer,
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "idempotency_keys_account_id_key_pk" PRIMARY KEY ("account_id", "key")
);
--> statement-breakpoint
CREATE TABLE "kb_entries" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "tags" text NOT NULL DEFAULT '[]',
  "workflow_dedup_key" text,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "kb_entries_workflow_dedup_key_unique" UNIQUE ("workflow_dedup_key")
);
--> statement-breakpoint
CREATE TABLE "learning_signals" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "triggering_action_id" text NOT NULL,
  "kind" text NOT NULL,
  "sender_address" text,
  "sender_domain" text,
  "destination" text,
  "label" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "learning_signals_account_id_triggering_action_id_unique" UNIQUE ("account_id", "triggering_action_id")
);
--> statement-breakpoint
CREATE TABLE "mailbox_credentials" (
  "mailbox_id" text NOT NULL,
  "transport" text NOT NULL,
  "secret_enc" text NOT NULL,
  "key_version" integer NOT NULL,
  "meta" text,
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "mailbox_credentials_mailbox_id_transport_pk" PRIMARY KEY ("mailbox_id", "transport"),
  FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id")
);
--> statement-breakpoint
CREATE TABLE "mailbox_folders" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "mailbox_id" text NOT NULL,
  "folder" text NOT NULL,
  "uidvalidity" integer,
  "uidnext" integer,
  "highestmodseq" integer,
  "delta_token" text,
  "server_exists" integer,
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "mailbox_folders_mailbox_id_folder_unique" UNIQUE ("mailbox_id", "folder"),
  FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id")
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "provider" text NOT NULL,
  "address" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "display_name" text,
  "status" text NOT NULL DEFAULT 'connected',
  "last_sync_at" integer,
  "auth_kind" text NOT NULL DEFAULT 'password',
  "error_code" text,
  "error_detail" text,
  "failed_at" integer,
  "retry_count" integer NOT NULL DEFAULT 0,
  "retry_after" integer,
  "kickstart_at" integer,
  "disabled_reason" text,
  "takeover_authorized_at" integer,
  "takeover_intent" text NOT NULL DEFAULT 'join',
  "organizer_role" text NOT NULL DEFAULT 'organizer',
  "organized_by_kind" text,
  "organized_by_name" text,
  "organized_by_install_id" text,
  "organized_since" integer,
  "organizer_state" text,
  "organized_by_capabilities" text,
  "organize_consented_at" integer,
  "organizer_event_at" integer,
  "organizer_event_seen_at" integer,
  "release_requested_at" integer,
  "organizer_released_at" integer,
  "junk_folder" text,
  "trash_folder" text,
  "folders_disabled_at" integer,
  "signature" text,
  "junk_sweep_requested_at" integer,
  "inbound_quiet_since" integer,
  "inbound_quiet_dismissed_at" integer,
  "sync_blocked_reason" text,
  "sync_blocked_since" integer,
  "sync_requested_at" integer,
  "smtp_max_size_bytes" integer,
  "smtp_size_probed_at" integer,
  "smtp_size_probe_code" text,
  "sensitive_rescreen_at" integer,
  "sensitive_rescreen_cursor" text,
  "sensitive_rescreen_started_at" integer,
  "sensitive_fp_backfill_at" integer,
  "initial_import_completed_at" integer,
  -- NO CHECK FOR `disabled_reason`, `sync_blocked_reason` OR `organized_by_kind`, DELIBERATELY.
  -- The server has widened all three by DROP CONSTRAINT then ADD (mail 0027/0103, 0029/0102,
  -- 0083/0103). SQLite has neither statement, so a CHECK here would make the next one-word
  -- widening a fifty-column table rebuild on every device. The members are refused at the write
  -- door instead — `packages/db/src/closed-sets.ts`, the same refusal on both dialects.
  -- The three below are immutable: added once, closed by an invariant, so the store enforces them.
  CONSTRAINT "mailboxes_organizer_role_closed" CHECK ("organizer_role" in ('organizer', 'reader')),
  CONSTRAINT "mailboxes_organizer_state_closed" CHECK ("organizer_state" is null or "organizer_state" in ('held', 'stopped')),
  CONSTRAINT "mailboxes_takeover_intent_closed" CHECK ("takeover_intent" in ('join', 'takeover'))
);
--> statement-breakpoint
CREATE TABLE "message_bodies" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "message_id" text NOT NULL,
  "text" text NOT NULL DEFAULT '',
  "html" text,
  "headers" text NOT NULL DEFAULT '{}',
  "loaded_remote_content" integer NOT NULL DEFAULT false,
  "withheld_reason" text,
  CONSTRAINT "message_bodies_message_id_unique" UNIQUE ("message_id"),
  CONSTRAINT "message_bodies_html_cap" CHECK (octet_length("html") <= 262144),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE TABLE "message_failures" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "folder" text NOT NULL,
  "uidvalidity" integer NOT NULL,
  "uid" integer NOT NULL,
  "code" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "attempted_version" text,
  "first_failed_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "last_failed_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "next_attempt_at" integer,
  "resolved_at" integer,
  CONSTRAINT "message_failures_locator_uq" UNIQUE ("mailbox_id", "folder", "uidvalidity", "uid"),
  FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id")
);
--> statement-breakpoint
CREATE TABLE "message_instances" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "message_id" text NOT NULL,
  "folder" text NOT NULL,
  "uidvalidity" integer NOT NULL,
  "uid" integer NOT NULL,
  "is_primary" integer NOT NULL DEFAULT false,
  "first_seen_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "last_seen_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "message_instances_locator_uq" UNIQUE ("mailbox_id", "folder", "uidvalidity", "uid"),
  FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id"),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE TABLE "message_states" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "message_id" text NOT NULL,
  "state" text NOT NULL DEFAULT 'none',
  "bubble_up_at" integer,
  "set_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "message_states_message_id_unique" UNIQUE ("message_id"),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE TABLE "message_tags" (
  "account_id" text NOT NULL,
  "message_id" text NOT NULL,
  "tag_id" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "message_tags_message_id_tag_id_pk" PRIMARY KEY ("message_id", "tag_id"),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id"),
  FOREIGN KEY ("tag_id") REFERENCES "tags"("id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "message_id_header" text,
  "body_hash" text NOT NULL,
  "dedup_key" text NOT NULL,
  "subject" text NOT NULL DEFAULT '',
  "from_address" text NOT NULL DEFAULT '',
  "from_name" text,
  "date" integer,
  "native_locator" text,
  "no_ai" integer NOT NULL DEFAULT false,
  "no_forward" integer NOT NULL DEFAULT false,
  "no_kb" integer NOT NULL DEFAULT false,
  "priority" integer NOT NULL DEFAULT false,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "thread_id" text,
  "unread" integer NOT NULL DEFAULT true,
  "last_read_at" integer,
  "deleted_at" integer,
  "snippet" text NOT NULL DEFAULT '',
  "to_addresses" text NOT NULL DEFAULT '[]',
  "cc_addresses" text NOT NULL DEFAULT '[]',
  "has_attachments" integer NOT NULL DEFAULT false,
  "attachment_count" integer NOT NULL DEFAULT 0,
  "sensitivity_category" text,
  "auth_verdict" text,
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "messages_mailbox_id_dedup_key_unique" UNIQUE ("mailbox_id", "dedup_key"),
  FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id"),
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id")
);
--> statement-breakpoint
CREATE TABLE "notify_rules" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "target" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'sender',
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE "organizer_requests" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "kind" text NOT NULL,
  "payload" text NOT NULL,
  "decided_at" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "sent_at" integer,
  "resolved_at" integer,
  "refused_reason" text,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE "outbound_sends" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "draft_id" text NOT NULL,
  "minted_message_id" text NOT NULL,
  "provider_message_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "sent_at" integer,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "outbound_sends_account_id_idempotency_key_unique" UNIQUE ("account_id", "idempotency_key"),
  FOREIGN KEY ("draft_id") REFERENCES "drafts"("id")
);
--> statement-breakpoint
CREATE TABLE "pairing_tokens" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "created_by_user_id" text,
  "grant" text NOT NULL,
  "token_hash" text NOT NULL,
  "label" text NOT NULL DEFAULT '',
  "expires_at" integer NOT NULL,
  "consumed_at" integer,
  "revoked_at" integer,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "pairing_tokens_token_hash_unique" UNIQUE ("token_hash"),
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "family_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" integer NOT NULL,
  "consumed_at" integer,
  "revoked_at" integer,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE ("token_hash"),
  FOREIGN KEY ("user_id") REFERENCES "users"("id"),
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
);
--> statement-breakpoint
CREATE TABLE "routing_decisions" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "message_id" text NOT NULL,
  "input_provenance" text NOT NULL,
  "matched_rule_id" text,
  "destination" text NOT NULL,
  "confidence" real,
  "rationale" text,
  "spam" integer NOT NULL DEFAULT false,
  "status" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE TABLE "rules" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "kind" text NOT NULL,
  "match" text NOT NULL,
  "destination" text NOT NULL,
  "priority" integer NOT NULL DEFAULT 0,
  "provenance" text NOT NULL DEFAULT 'manual',
  "enabled" integer NOT NULL DEFAULT true,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "hits" integer NOT NULL DEFAULT 0,
  "last_hit_at" integer,
  "demotions" integer NOT NULL DEFAULT 0,
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "retro_requested_at" integer,
  "retro_done_at" integer,
  "retro_cursor" text,
  "retro_moved" integer NOT NULL DEFAULT 0,
  "subject_contains" text,
  "body_contains" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "user_id" text NOT NULL,
  "device_id" text,
  "family_id" text NOT NULL,
  "access_token_hash" text,
  "scope" text NOT NULL DEFAULT 'full',
  "access_expires_at" integer NOT NULL,
  "refresh_expires_at" integer NOT NULL,
  "last_twofa_at" integer,
  "revoked_at" integer,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "last_seen_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "last_synced_at" integer,
  FOREIGN KEY ("user_id") REFERENCES "users"("id"),
  FOREIGN KEY ("device_id") REFERENCES "devices"("id")
);
--> statement-breakpoint
CREATE TABLE "snippets" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "shortcut" text,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE "tags" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "name" text NOT NULL,
  "hue" text NOT NULL DEFAULT 'moss',
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE "thread_notes" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "body" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "subject" text NOT NULL DEFAULT '',
  "participants" text NOT NULL DEFAULT '[]',
  "last_message_at" integer,
  "muted" integer NOT NULL DEFAULT false,
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "root_message_id_header" text
);
--> statement-breakpoint
CREATE TABLE "tracker_events" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "message_id" text NOT NULL,
  "kind" text NOT NULL,
  "tracker_host" text,
  "url" text,
  "detected_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE TABLE "unsubscribe_records" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "list_key" text NOT NULL,
  "state" text NOT NULL,
  "refusal" text,
  "http_status" integer,
  "message_id" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id"),
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
);
--> statement-breakpoint
CREATE TABLE "users" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "email" text NOT NULL,
  "display_name" text NOT NULL DEFAULT '',
  "email_verified_at" integer,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "users_account_id_email_unique" UNIQUE ("account_id", "email"),
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
);
--> statement-breakpoint
CREATE TABLE "workflow_proposals" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "name" text NOT NULL,
  "rationale" text NOT NULL DEFAULT '',
  "trigger" text NOT NULL DEFAULT '{}',
  "steps" text NOT NULL DEFAULT '[]',
  "source_pattern" text,
  "status" text NOT NULL DEFAULT 'open',
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "workflow_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "trigger" text NOT NULL DEFAULT '{}',
  "log" text NOT NULL DEFAULT '[]',
  "step_cursor" integer NOT NULL DEFAULT 0,
  "reason" text,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "finished_at" integer,
  "claimed_at" integer,
  FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id")
);
--> statement-breakpoint
CREATE TABLE "workflows" (
  "id" text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "account_id" text NOT NULL,
  "name" text NOT NULL,
  "trigger" text NOT NULL DEFAULT '{}',
  "steps" text NOT NULL DEFAULT '[]',
  "enabled" integer NOT NULL DEFAULT false,
  "provenance" text NOT NULL DEFAULT 'user',
  "deleted_at" integer,
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
--> statement-breakpoint
CREATE INDEX "approvals_account_status_idx" ON "approvals" ("account_id", "status");
--> statement-breakpoint
CREATE INDEX "attachments_account_message_idx" ON "attachments" ("account_id", "message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "away_replies_message_uq" ON "away_replies" ("account_id", "message_id");
--> statement-breakpoint
CREATE INDEX "away_replies_sender_idx" ON "away_replies" ("account_id", "sender", "decided_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "away_responder_sent_episode_uq" ON "away_responder_sent" ("account_id", "sender", "responder_updated_at");
--> statement-breakpoint
CREATE INDEX "away_responder_sent_account_idx" ON "away_responder_sent" ("account_id");
--> statement-breakpoint
CREATE INDEX "change_log_move_to_inbox_idx" ON "change_log" ("account_id", "entity_id") WHERE "op" = 'move' and "meta" ->> 'to' = 'INBOX';
--> statement-breakpoint
CREATE INDEX "contact_notes_account_contact_idx" ON "contact_notes" ("account_id", "contact_id");
--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" ("user_id");
--> statement-breakpoint
CREATE INDEX "drafts_account_updated_idx" ON "drafts" ("account_id", "updated_at");
--> statement-breakpoint
CREATE INDEX "drafts_scheduled_due_idx" ON "drafts" ("send_at") WHERE "status" = 'scheduled';
--> statement-breakpoint
CREATE INDEX "kb_entries_account_idx" ON "kb_entries" ("account_id");
--> statement-breakpoint
CREATE INDEX "learning_signals_account_idx" ON "learning_signals" ("account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_active_address_uq" ON "mailboxes" ("account_id", lower("address")) WHERE "status" <> 'disabled';
--> statement-breakpoint
CREATE INDEX "message_bodies_withheld_idx" ON "message_bodies" ("withheld_reason", "message_id") WHERE "withheld_reason" is not null;
--> statement-breakpoint
CREATE INDEX "message_instances_message_idx" ON "message_instances" ("message_id");
--> statement-breakpoint
CREATE INDEX "message_states_account_state_idx" ON "message_states" ("account_id", "state");
--> statement-breakpoint
CREATE INDEX "message_tags_account_message_idx" ON "message_tags" ("account_id", "message_id");
--> statement-breakpoint
CREATE INDEX "message_tags_tag_idx" ON "message_tags" ("tag_id");
--> statement-breakpoint
CREATE INDEX "messages_account_thread_idx" ON "messages" ("account_id", "thread_id");
--> statement-breakpoint
CREATE INDEX "messages_account_message_id_header_idx" ON "messages" ("account_id", "message_id_header");
--> statement-breakpoint
CREATE INDEX "messages_account_mailbox_unread_idx" ON "messages" ("account_id", "mailbox_id", "unread");
--> statement-breakpoint
CREATE INDEX "messages_account_from_addr_idx" ON "messages" ("account_id", lower("from_address"), "id");
--> statement-breakpoint
CREATE INDEX "messages_account_from_domain_idx" ON "messages" ("account_id", substr(lower("from_address"), instr(lower("from_address"), '@') + 1), "id");
--> statement-breakpoint
CREATE INDEX "notify_rules_account_idx" ON "notify_rules" ("account_id");
--> statement-breakpoint
CREATE INDEX "organizer_requests_mailbox_state_idx" ON "organizer_requests" ("mailbox_id", "state");
--> statement-breakpoint
CREATE INDEX "organizer_requests_account_state_idx" ON "organizer_requests" ("account_id", "state");
--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" ("family_id");
--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_idx" ON "refresh_tokens" ("session_id");
--> statement-breakpoint
CREATE INDEX "routing_decisions_account_message_idx" ON "routing_decisions" ("account_id", "message_id");
--> statement-breakpoint
CREATE INDEX "rules_retro_owed_idx" ON "rules" ("account_id") WHERE "retro_requested_at" is not null and "retro_done_at" is null;
--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" ("family_id");
--> statement-breakpoint
CREATE INDEX "sessions_access_token_hash_idx" ON "sessions" ("access_token_hash");
--> statement-breakpoint
CREATE INDEX "snippets_account_idx" ON "snippets" ("account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tags_account_name_uq" ON "tags" ("account_id", lower("name"));
--> statement-breakpoint
CREATE INDEX "thread_notes_account_thread_idx" ON "thread_notes" ("account_id", "thread_id");
--> statement-breakpoint
CREATE INDEX "threads_account_last_message_idx" ON "threads" ("account_id", "last_message_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "threads_account_root_header_uq" ON "threads" ("account_id", "root_message_id_header");
--> statement-breakpoint
CREATE INDEX "tracker_events_account_message_idx" ON "tracker_events" ("account_id", "message_id");
--> statement-breakpoint
CREATE INDEX "tracker_events_account_detected_idx" ON "tracker_events" ("account_id", "detected_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "unsubscribe_records_mailbox_list_uq" ON "unsubscribe_records" ("mailbox_id", "list_key");
--> statement-breakpoint
CREATE INDEX "unsubscribe_records_account_idx" ON "unsubscribe_records" ("account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique_idx" ON "users" ("email");
--> statement-breakpoint
CREATE INDEX "workflow_proposals_account_status_idx" ON "workflow_proposals" ("account_id", "status");
--> statement-breakpoint
CREATE INDEX "workflow_runs_account_status_idx" ON "workflow_runs" ("account_id", "status");
--> statement-breakpoint
CREATE INDEX "workflows_account_idx" ON "workflows" ("account_id");
--> statement-breakpoint
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_address,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
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
CREATE VIRTUAL TABLE message_bodies_fts USING fts5(
  text,
  content='message_bodies',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
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
CREATE VIRTUAL TABLE kb_entries_fts USING fts5(
  title, content,
  content='kb_entries',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER kb_entries_fts_after_insert AFTER INSERT ON kb_entries BEGIN
  INSERT INTO kb_entries_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER kb_entries_fts_after_delete AFTER DELETE ON kb_entries BEGIN
  INSERT INTO kb_entries_fts(kb_entries_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
--> statement-breakpoint
CREATE TRIGGER kb_entries_fts_after_update AFTER UPDATE ON kb_entries BEGIN
  INSERT INTO kb_entries_fts(kb_entries_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO kb_entries_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

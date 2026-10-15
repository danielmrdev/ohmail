-- 0145_press_decided_at — the stale-press floor's stamp; the pg columns' twins (epoch ms).

ALTER TABLE "folder_state" ADD COLUMN "decided_at" integer;--> statement-breakpoint
ALTER TABLE "flag_state" ADD COLUMN "decided_at" integer;--> statement-breakpoint
ALTER TABLE "message_states" ADD COLUMN "decided_at" integer;

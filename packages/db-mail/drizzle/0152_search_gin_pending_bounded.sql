-- 0152_search_gin_pending_bounded — the search document's GIN indexes keep a 256 kB pending list.
--
-- A GIN index with fastupdate parks new entries in a pending list (4 MB by default) that EVERY search
-- reads in full, whichever account wrote them: fresh mail in another account made a page read a
-- quarter more buffers. At 256 kB (the desktop store's own bound) the list stays a few pages; a
-- one-message commit costs as before and a batch under a millisecond a document, where fastupdate
-- off cost several. The trigram index is built outside the journal (`search-setup.ts`,
-- which now builds it with the same option), so it is set only where it exists. Each list is flushed
-- once. Storage parameters only: SHARE UPDATE EXCLUSIVE, no rewrite, idempotent on replay.

ALTER INDEX IF EXISTS "message_search_head_tsv_idx" SET (gin_pending_list_limit = 256);
--> statement-breakpoint
ALTER INDEX IF EXISTS "message_search_text_tsv_idx" SET (gin_pending_list_limit = 256);
--> statement-breakpoint
ALTER INDEX IF EXISTS "message_search_terms_trgm_idx" SET (gin_pending_list_limit = 256);
--> statement-breakpoint
SELECT gin_clean_pending_list(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind = 'i'
    AND c.relname IN ('message_search_head_tsv_idx', 'message_search_text_tsv_idx', 'message_search_terms_trgm_idx');

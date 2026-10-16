/**
 * The REQUIRED cloud-marker set, derived from the CLOUD journal's own SQL rather than from
 * `CLOUD_SCHEMA_MARKERS.length`. The hosted `/health` (and the admin overview) computed the marker
 * total from the lists, so deleting an OLDER cloud marker lowered `found` and the expected total
 * together and read healthy — a database with a silently missing column, the inverted
 * `schema_incomplete` incident. `deriveCloudColumnMarkerCount()` reads `CLOUD_JOURNAL` instead, and
 * `cloud-health-markers-from-the-journal.test.ts` asserts coverage in both directions.
 *
 * The parser is the shared {@link parseJournalObjects}, at its default `[a-z0-9_]+` identifier
 * class — the cloud journal names columns with digits (`platform_signals.errors_5xx`,
 * `push_subscriptions.p256dh`) that the mail half's narrower class would miss.
 */
import { CLOUD_JOURNAL } from "@trafficflow/db/admin";
import {
  parseJournalObjects,
  deriveColumnMarkerCount,
  type JournalObjects,
} from "./journal-marker-derivation.js";

/** The cloud journal's objects — {@link JournalObjects} shape. */
export type CloudJournalObjects = JournalObjects;

/** The cloud journal's objects, at the shared parser's digit-admitting default identifier class. */
export const parseCloudJournalObjects = (): CloudJournalObjects => parseJournalObjects(CLOUD_JOURNAL);

/**
 * The GRANDFATHER list: `(migration, table)` column facets the cloud journal creates that carry no
 * `CLOUD_SCHEMA_MARKERS` entry, each with the reason. Measured 2026-09-14 against the cloud journal
 * (through 0035): 32 facets, 20 marked, and these 12 the pre-existing gap. Every one is BASELINE
 * era — its `when` is at or below `LEGACY_CUTOFF_WHEN` (1786006486206), so it is certified by
 * baseline ADOPTION (`baseline.ts#baselineObjects` verifies the table/column exists), not by a
 * per-migration health marker. There is no post-baseline gap: every cloud migration after the
 * split that adds a probeable column carries a marker. The test starts green on this list and any
 * NEW unmarked facet reddens it.
 */
export const CLOUD_COLUMN_FACET_ALLOWLIST: Record<string, string> = {
  // 0000 auth ceremony (pre-split): the identity tables, certified by adoption. Two of them are
  // additionally probed through a LATER migration's sharper column, named below.
  "0000_auth_ceremony|auth_events": "baseline: the auth-event ledger, certified by adoption; not on a certified API read path",
  "0000_auth_ceremony|auth_throttle": "baseline: the sign-in throttle ledger, certified by adoption",
  "0000_auth_ceremony|credentials": "baseline: the password credential store, certified by adoption (a missing table fails sign-in loudly)",
  "0000_auth_ceremony|login_tokens": "baseline: login_tokens is later probed at 0010.challenge_hash",
  "0000_auth_ceremony|oauth_auth_codes": "baseline: oauth_auth_codes is later probed at 0017.twofa_at",
  "0000_auth_ceremony|recovery_codes": "baseline: the 2FA recovery-code store, certified by adoption",
  "0000_auth_ceremony|refresh_tokens": "baseline: refresh_tokens, certified by adoption (also adopted by mail 0060 — CLOUD_OBJECTS_ADOPTED_BY_MAIL)",
  "0000_auth_ceremony|totp_secrets": "baseline: the TOTP secret store, certified by adoption",
  "0000_auth_ceremony|webauthn_challenges": "baseline: webauthn_challenges is later probed by its index markers (0034/0035)",
  "0000_auth_ceremony|webauthn_credentials": "baseline: the passkey credential store, certified by adoption",
  "0001_push_subscriptions|push_subscriptions": "baseline: push_subscriptions (web push) carries no health marker; not on a certified API read path",
  "0003_observability|alert_state": "baseline: alert_state is later probed at 0025.notified_signature / 0026.claimed_until / 0030.cls",
};

/**
 * The cloud facets the design deliberately probes TWICE — two `CLOUD_SCHEMA_MARKERS` entries on one
 * `(migration, table)` — because the two columns answer different questions (see the
 * `CLOUD_SCHEMA_MARKERS` docblocks). They are the difference between "20 marked facets" and "21
 * cloud column markers".
 */
export const CLOUD_DELIBERATE_DOUBLE_PROBES: Record<string, string> = {
  "0030_heartbeat_signals_alert_runs|platform_signals": "errors_5xx (the 5xx sample count) and sample_cause (0030's last column) — two probes, two questions",
};

/**
 * The required number of cloud COLUMN markers, from the journal and the two allow-lists above —
 * never from `CLOUD_SCHEMA_MARKERS.length`. A dropped marker leaves this number unchanged, so the
 * probe assertion it anchors turns red.
 */
export function deriveCloudColumnMarkerCount(
  objects: CloudJournalObjects = parseCloudJournalObjects(),
): number {
  return deriveColumnMarkerCount(objects, CLOUD_COLUMN_FACET_ALLOWLIST, CLOUD_DELIBERATE_DOUBLE_PROBES);
}

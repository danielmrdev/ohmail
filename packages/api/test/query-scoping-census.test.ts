import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutCommentsAndLiterals, lineOf } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY QUERY NAMES ITS ACCOUNT, OR NAMES ITS PROOF (review 020, BACKEND L5). Account isolation
 * on the tables without an `account_id` column (`message_bodies`, `folder_state`,
 * `message_states`, …) rests on chained proof — every site reaches them through an
 * account-scoped parent read — and nothing structural refused the NEXT unbound read. This census
 * walks every `db`/`tx` call site under both roots and requires one of: an account/mailbox/user
 * predicate in the statement's own text, a table whose rows are not account-owned (the allowlist,
 * each entry with its reason), the staff console's file, or a `// scoped-by:` annotation naming
 * the parent check. The heuristic is the review's own (blanked literals, so a raw-sql bind reads
 * unbound and must say so in its annotation). RUN BY NAME when packages/services moves —
 * touched-package selection cannot see across roots into this file.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const ROOTS = ["packages/api/src", "packages/services/src"];

/** Tables whose rows are NOT located by account ownership — each with the reason it is sound. */
const TABLE_ALLOWLIST: Record<string, string> = {
  sessions: "token-keyed: the row is found by the presented token's hash — possession authorizes",
  refreshTokens: "token-keyed: found by the presented refresh token's hash",
  loginTokens: "token-keyed: found by the presented login token's hash",
  oauthAuthCodes: "token-keyed: found by the presented single-use code's hash",
  webauthnChallenges: "token-keyed: found by the challenge the ceremony presents, then pruned",
  webauthnCredentials: "credential-keyed: found by the authenticator's own credential id",
  recoveryCodes: "credential-keyed: found by the presented code's hash",
  pairingTokens: "token-keyed: found by the presented pairing token's hash",
  invites: "code-keyed: an invite is redeemed by its code before any account exists",
  waitlist: "email-keyed signup funnel: rows exist before the account they may become",
  authThrottle: "global throttle keyed by a keyed hash of the address and client, or a user id — deliberately accountless",
  staffUsers: "staff plane: operators are not customer accounts; the staff session guards reach",
  staffAuditLog: "staff plane: the operators' own audit trail",
  staffRoleGrants: "staff plane: an operator's roles, keyed by the staff member, never by an account",
  staffAuditEvents: "staff plane: what operators did, written per staff request; the target account is a column, not a scope",
  workerHeartbeats: "operational: worker liveness, accountless by design",
  platformSignals: "operational: the hosting platform's own request-log readings",
};

/** Files whose unbound reads over customer tables are one mechanism, named once. */
const FILE_ALLOWLIST: Record<string, string> = {
  "packages/services/src/admin-service.ts":
    "the staff console reads across accounts by design; the route guards (shared secret + staff "
    + "session) hold the door, and admin-content-isolation.test.ts holds what it may render",
};

const BOUND = /account_?[iI]d|mailbox_?[iI]d|user_?[iI]d|\baccounts\.id\b|\busers\.id\b|\bmailboxes\.id\b|installId|staff_?[sS]ession|byAccount|forAccount|scopedTo/;
const CALL = /\b(db|tx|this\.db|deps\.db)\s*\.\s*(select|insert|update|delete|execute)\s*(\(|<)/g;

/** How many raw lines above the call a `// scoped-by:` annotation may sit. */
const ANNOTATION_REACH = 3;
const ANNOTATION = /\/\/\s*scoped-by:\s*(.+)$/;

interface Site { file: string; line: number; verb: string; table: string; ok: string | null }

function sources(): { file: string; raw: string }[] {
  const out: { file: string; raw: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (extname(p) === ".ts") out.push({ file: relative(REPO, p), raw: readFileSync(p, "utf8") });
    }
  };
  for (const r of ROOTS) walk(join(REPO, r));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** The statement span: from the call to the first `;` at depth<=0, bounded like the review's scan. */
function stmtSpan(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length && i < from + 8000; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth < 0) return src.slice(from, i); }
    else if (c === ";" && depth <= 0) return src.slice(from, i);
  }
  return src.slice(from, from + 8000);
}

function tableOf(stmt: string): string {
  const t = stmt.match(/\b(?:from|into|insert|update|delete)\s*\(\s*([A-Za-z_$][\w$]*)/)
    || stmt.match(/\.(?:from|into)\s*\(\s*([A-Za-z_$][\w$]*)/);
  return t ? t[1] : "(raw)";
}

/** Every call site in one file, classified. `ok` names why it is admitted; null refuses. */
function sitesIn(file: string, raw: string): Site[] {
  const src = withoutCommentsAndLiterals(raw) as string;
  const rawLines = raw.split("\n");
  const out: Site[] = [];
  for (const m of src.matchAll(CALL)) {
    const stmt = stmtSpan(src, m.index);
    const line = lineOf(src, m.index) as number;
    const table = tableOf(stmt);
    let ok: string | null = null;
    if (BOUND.test(stmt)) ok = "bound";
    else if (table in TABLE_ALLOWLIST) ok = `table: ${TABLE_ALLOWLIST[table]}`;
    else if (file in FILE_ALLOWLIST) ok = `file: ${FILE_ALLOWLIST[file]}`;
    else {
      // An annotation within reach, in the RAW text (comments are what the strip removed).
      for (let l = line - 1; l >= Math.max(0, line - 1 - ANNOTATION_REACH); l--) {
        const a = rawLines[l - 1]?.match(ANNOTATION);
        if (a) { ok = a[1].trim().length >= 10 ? `scoped-by: ${a[1].trim()}` : null; break; }
      }
    }
    out.push({ file, line, verb: m[2], table, ok });
  }
  return out;
}

describe("query scoping census", () => {
  const files = sources();
  const sites = files.flatMap((f) => sitesIn(f.file, f.raw));

  it("every unbound site is allowlisted with a reason or annotated with its parent check", () => {
    const refused = sites.filter((s) => s.ok === null)
      .map((s) => `${s.file}:${s.line} ${s.verb} ${s.table}`);
    expect(refused, "db/tx call sites with no predicate, no allowlisted table and no scoped-by annotation")
      .toEqual([]);
  });

  it("the census is measuring something (vacuity guards)", () => {
    // Floors well under the measured values (679 / 509 / 18 tables at adoption) — a refactor
    // moves them, a broken scanner zeroes them, and zero is the reading this arm refuses.
    expect(sites.length, "total call sites").toBeGreaterThanOrEqual(600);
    expect(sites.filter((s) => s.ok === "bound").length, "bound sites").toBeGreaterThanOrEqual(400);
    expect(sites.filter((s) => s.ok?.startsWith("scoped-by:")).length, "annotated sites")
      .toBeGreaterThanOrEqual(40);
    expect(sites.filter((s) => s.ok?.startsWith("table:")).length, "allowlisted-table sites")
      .toBeGreaterThanOrEqual(50);
    // The three no-account-column tables the review names are all under census, somewhere.
    for (const t of ["messageBodies", "folderState", "messageStates"]) {
      expect(sites.some((s) => s.table === t), `${t} sites swept`).toBe(true);
    }
  });

  it("refuses the synthetic offenders and admits the proven shapes (positive control)", () => {
    const at = (body: string) => sitesIn("packages/" + "services/src/synthetic.ts", body);

    // An unbound read of a chained-proof table with no annotation: the exact next-author defect.
    const bare = at("const rows = await db.select().from(messageBodies).limit(5);\n");
    expect(bare.length).toBe(1);
    expect(bare[0].ok).toBeNull();

    // The same read carrying its proof is admitted.
    const annotated = at(
      "// scoped-by: ids come from the account-scoped messages read above\n"
      + "const rows = await db.select().from(messageBodies).limit(5);\n",
    );
    expect(annotated[0].ok).toMatch(/^scoped-by:/);

    // A bare marker with no named parent is refused — the annotation is the proof, not a wave.
    const waved = at("// scoped-by: ok\nconst rows = await db.select().from(messageBodies);\n");
    expect(waved[0].ok).toBeNull();

    // An annotation out of reach is refused: proximity is what ties the claim to the site.
    const far = at(
      "// scoped-by: ids come from the account-scoped messages read above\n\n\n\n\n"
      + "const rows = await db.select().from(messageBodies);\n",
    );
    expect(far[0].ok).toBeNull();

    // A bound read and an allowlisted table are admitted without annotation.
    const bound = at("await tx.update(drafts).set({ x: 1 }).where(eq(drafts.accountId, ctx.accountId));\n");
    expect(bound[0].ok).toBe("bound");
    const tokenKeyed = at("const [s] = await db.select().from(sessions).where(eq(sessions.tokenHash, h));\n");
    expect(tokenKeyed[0].ok).toMatch(/^table:/);
  });
});

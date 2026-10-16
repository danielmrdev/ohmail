import { describe, it, expect } from "vitest";
import { accounts, mailboxes, users } from "@trafficflow/db";
import type { ApiDeps } from "@trafficflow/api";
import type { AdminSearchPage, StaffRole } from "@trafficflow/services";
import { FIXED_NOW } from "./helpers.js";
import { queryHmacOf } from "../src/staff-audit.js";
import { H, get, seedStaff, staffDeps, auditRowsFor, SECRET } from "./_staff-fixtures.js";

/**
 * `GET /admin/search` — exact and prefix matches only, never a substring (cloud 0047). Each
 * class is driven by its own term, and each has a near miss that must find nothing: a substring
 * of the name, of the address and of the domain.
 */

const A = "3a1f0c2e-9b7d-4e21-8c0a-7d4b2e8f6a11";
const B = "b7c2d4e6-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
const USER_A = "0c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f";
const MAILBOX_A = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

async function world(roles: readonly StaffRole[] = ["support"]): Promise<{ deps: ApiDeps; token: string; staffId: string }> {
  const deps = await staffDeps();
  await deps.db.insert(accounts).values([
    { id: A, name: "Müller GmbH", createdAt: FIXED_NOW },
    { id: B, name: "Beta Works", createdAt: FIXED_NOW, erasedAt: FIXED_NOW },
  ]);
  await deps.db.insert(users).values([
    { id: USER_A, accountId: A, email: "anna@alpha.example", createdAt: FIXED_NOW },
    { accountId: B, email: "bob@beta.example", createdAt: FIXED_NOW },
  ]);
  await deps.db.insert(mailboxes).values([
    { id: MAILBOX_A, accountId: A, provider: "imap", address: "Inbox@Alpha-Mail.example" },
    { accountId: B, provider: "imap", address: "bob@beta.example" },
  ]);
  const staff = await seedStaff(deps, { roles });
  return { deps, token: staff.token, staffId: staff.staffId };
}

async function search(w: { deps: ApiDeps; token: string }, q: string): Promise<AdminSearchPage> {
  const res = await H(get(`/admin/search?q=${encodeURIComponent(q)}`, w.token), w.deps);
  expect(res.status, q).toBe(200);
  return (await res.json()) as AdminSearchPage;
}

const matches = (page: AdminSearchPage): string[] => page.results.map((r) => `${r.accountId}:${r.matchedOn}`);

describe("admin search matches exactly, never by substring", () => {
  it.each([
    ["the account id", A, `${A}:account_id`],
    ["the account id without hyphens", A.replace(/-/g, ""), `${A}:account_id`],
    ["an 8-hex prefix of the account id", A.slice(0, 8), `${A}:account_id_prefix`],
    ["a longer hex prefix, hyphens dropped", A.replace(/-/g, "").slice(0, 20), `${A}:account_id_prefix`],
    ["a user id", USER_A, `${A}:user`],
    ["a mailbox id", MAILBOX_A, `${A}:mailbox`],
    ["the login address, in any case", "ANNA@alpha.example", `${A}:login_address`],
    ["the mailbox address, in any case", "inbox@alpha-mail.EXAMPLE", `${A}:mailbox_address`],
    ["the mailbox domain", "alpha-mail.example", `${A}:mailbox_domain`],
    ["the mailbox domain written @domain", "@alpha-mail.example", `${A}:mailbox_domain`],
    ["the account name's folded prefix", "mull", `${A}:account_name`],
    ["the account name's prefix with its accent", "Mül", `${A}:account_name`],
  ])("finds %s", async (_label, q, want) => {
    const w = await world();
    expect(matches(await search(w, q))).toEqual([want]);
  });

  it.each([
    ["a substring of the name", "üller"],
    ["a substring of the login address", "nna@alpha.example"],
    ["a substring of the domain", "mail.example"],
    ["a 7-hex prefix, below the floor", A.slice(0, 7)],
    ["a hex string from the middle of the id", A.replace(/-/g, "").slice(4, 16)],
    ["an empty term", ""],
  ])("finds nothing for %s", async (_label, q) => {
    const w = await world();
    expect((await search(w, q)).results).toEqual([]);
  });

  it("an address that is both a login and a mailbox is listed once, under the login", async () => {
    const w = await world();
    expect(matches(await search(w, "bob@beta.example"))).toEqual([`${B}:login_address`]);
  });

  it("carries the erasure stamp and a label of name and owner address", async () => {
    const w = await world();
    const [erased] = (await search(w, B)).results;
    expect(erased).toMatchObject({ accountId: B, erasedAt: FIXED_NOW.toISOString(), label: "Beta Works · bob@beta.example" });
  });

  it("masks the account holder's address for ops, and only for ops", async () => {
    const ops = await world(["ops"]);
    expect((await search(ops, A)).results[0]!.label).toBe("Müller GmbH · •••@alpha.example");
    const both = await world(["ops", "support"]);
    expect((await search(both, A)).results[0]!.label).toBe("Müller GmbH · anna@alpha.example");
  });

  it("answers at most 25 and says when more matched", async () => {
    const w = await world();
    await w.deps.db.insert(accounts).values(
      Array.from({ length: 30 }, (_, i) => ({ name: `Zeta ${String(i).padStart(2, "0")}`, createdAt: FIXED_NOW })),
    );
    const page = await search(w, "zeta");
    expect(page.results).toHaveLength(25);
    expect(page.truncated).toBe(true);
    expect((await search(w, "mull")).truncated).toBe(false);
  });

  it("records the term's keyed hash and never the term", async () => {
    const w = await world();
    await search(w, "Anna@Alpha.example");
    const [row] = await auditRowsFor(w.deps, w.staffId);
    expect(row!.action).toBe("read.search");
    expect(row!.queryHmac).toBe(queryHmacOf(SECRET, "anna@alpha.example"));
    expect(JSON.stringify(row).toLowerCase()).not.toContain("anna");
  });
});

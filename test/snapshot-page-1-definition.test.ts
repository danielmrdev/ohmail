/**
 * WHAT PAGE 1 CARRIES IS DERIVED FROM THE PRODUCER, NOT REMEMBERED.
 *
 * The client engine states the snapshot contract in prose so a reader of `engine.ts` knows what a
 * first page holds and why it sends no `limit`. That sentence went stale once already: it still
 * read "all live state" for a release after `SyncService.getSnapshot` had begun paging a message's
 * children with their parent, so the file most likely to be read by somebody wiring a new client
 * described a page shape the server had stopped producing.
 *
 * A corrected sentence is worth one release. What is worth keeping is this: the producer's page-1
 * block is PARSED — the `emit("<kind>", …)` calls inside `if (cursor === null) { … }`, by call
 * expression and not by mention — and compared against the client's own declaration. Add an
 * entity to page 1 and this file reddens until the client's list moves with it.
 *
 * Scanned roots: `packages/services/src` (the producer) and `packages/client-engine/src` (the
 * declaration). Touched-package selection reaches neither from the other — run it by exact path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { SNAPSHOT_PAGE_1_STATE_KINDS } from "../packages/client-engine/src/engine.js";

const PRODUCER = resolve(__dirname, "../packages/services/src/sync-service.ts");

/** The `getSnapshot` method's body, as an AST — the file's other methods are not the contract. */
function getSnapshotBody(): ts.Block {
  const src = ts.createSourceFile(
    PRODUCER, readFileSync(PRODUCER, "utf8"), ts.ScriptTarget.ES2022, true,
  );
  let found: ts.Block | undefined;
  const walk = (n: ts.Node): void => {
    if (ts.isMethodDeclaration(n) && n.name.getText() === "getSnapshot" && n.body) {
      found = n.body;
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  if (!found) throw new Error("getSnapshot not found in sync-service.ts — this census read nothing");
  return found;
}

/**
 * The `if (cursor === null) { … }` block: the statements that run ONLY for a first page. Located
 * by its condition rather than by position, so reordering the method does not silently move it.
 */
function pageOneBlock(body: ts.Block): ts.Block {
  let found: ts.Block | undefined;
  const walk = (n: ts.Node): void => {
    if (ts.isIfStatement(n) && /cursor\s*===\s*null/.test(n.expression.getText())
        && ts.isBlock(n.thenStatement) && n.elseStatement === undefined) {
      found ??= n.thenStatement;
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  if (!found) throw new Error("the `cursor === null` page-1 block is gone — re-derive this census");
  return found;
}

/**
 * Every kind the producer CONSTRUCTS under a node, first argument only, in source order.
 *
 * Two constructors, not one: the page-1 block calls `emit`, while the per-page half builds each
 * change with `changeOf` so the page's byte budget can weigh it before it is pushed. `emit` is
 * itself a `changeOf` call whose type argument is not a literal, so nothing is counted twice.
 * A reader that knew only `emit` read the per-page half as EMPTY the moment the budget landed.
 */
const CHANGE_BUILDERS = ["emit", "changeOf"];
function emittedKinds(node: ts.Node): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
        && CHANGE_BUILDERS.includes(n.expression.text)) {
      const a = n.arguments[0];
      if (a !== undefined && ts.isStringLiteral(a)) out.push(a.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

describe("snapshot page 1, as the producer builds it", () => {
  it("the client's declaration is exactly the producer's page-1 emit set", () => {
    const body = getSnapshotBody();
    const kinds = emittedKinds(pageOneBlock(body));

    // Not vacuous: a parse that found no calls would otherwise agree with an empty list.
    expect(kinds.length).toBeGreaterThan(0);
    expect([...new Set(kinds)].sort())
      .toEqual([...SNAPSHOT_PAGE_1_STATE_KINDS].sort());
  });

  it("the message window and its children are NOT page-1-only — the half the sentence got wrong", () => {
    // The stale sentence's actual error: it put the whole of every entity on page 1. `message`,
    // `thread` and the child kinds are emitted OUTSIDE the block, once per page, which is why a
    // client-imposed `limit` would cut a message away from its own children.
    const body = getSnapshotBody();
    const inBlock = new Set(emittedKinds(pageOneBlock(body)));
    const everyPage = emittedKinds(body).filter((k) => !inBlock.has(k));

    expect(everyPage).toContain("message");
    expect(everyPage).toContain("thread");
    // `draft` joined them when the producer started paging drafts newest-first: a page-1-only
    // declaration would promise a client the whole draft table on the first page.
    expect(everyPage).toContain("draft");
    for (const k of ["message", "thread", "draft"]) {
      expect(SNAPSHOT_PAGE_1_STATE_KINDS as readonly string[]).not.toContain(k);
    }
  });

  it("the locators are load-bearing — each refuses rather than answering empty", () => {
    // A census that silently found nothing is the shape this repository has shipped before.
    const empty = ts.createSourceFile("x.ts", "class A { other() {} }", ts.ScriptTarget.ES2022, true);
    let block: ts.Block | undefined;
    ts.forEachChild(empty, function walk(n: ts.Node): void {
      if (ts.isMethodDeclaration(n) && n.body) block = n.body;
      ts.forEachChild(n, walk);
    });
    expect(block).toBeDefined();
    expect(() => pageOneBlock(block!)).toThrow(/page-1 block is gone/);
    expect(emittedKinds(block!)).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * REPLY AND FORWARD ANSWER THE SAME MESSAGE. The reader's verbs act on the member it opened —
 * a conversation's latest unread message, else the newest one somebody else wrote — and Forward
 * takes that one resolver rather than a second rule of its own. Asserted over the syntax tree
 * (no React Native renderer here): the reader mounts ONE composer for every reply mode, handed
 * its own message, and inside it the reply send and the forward send name the same member.
 */

const SRC = readFileSync(fileURLToPath(new URL("../src/ui/MessageActions.tsx", import.meta.url)), "utf8");

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("MessageActions.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function all(sf: ts.SourceFile, pick: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (pick(n)) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** The first argument of every `w.actions.<verb>(…)` call — the member that send names. */
function targetsOf(source: string, verb: string): string[] {
  const sf = parse(source);
  return all(sf, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === `w.actions.${verb}`)
    .map((n) => (n as ts.CallExpression).arguments[0]!.getText(sf));
}

/** Every reader-side composer mount: its `m` and `mode` attributes. */
function mountsOf(source: string): Array<{ m: string; mode: string }> {
  const sf = parse(source);
  return all(sf, (n) => ts.isJsxSelfClosingElement(n) && n.tagName.getText(sf) === "ComposeSheet").map((n) => {
    const attr = (name: string) => (n as ts.JsxSelfClosingElement).attributes.properties
      .find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === name) as ts.JsxAttribute | undefined;
    const text = (a: ts.JsxAttribute | undefined) => a?.initializer?.getText(sf) ?? "";
    return { m: text(attr("m")), mode: text(attr("mode")) };
  });
}

/** What `openForward` opens the composer for: the member its id is read from. */
function forwardOpensFor(source: string): string | null {
  const at = source.indexOf("const openForward = () => {");
  const body = source.slice(at, source.indexOf("\n  };", at));
  return /const id = ([\w.!]+);/.exec(body)?.[1] ?? null;
}

describe("Reply and Forward resolve the same member", () => {
  it("the reply and forward sends name one member", () => {
    const reply = targetsOf(SRC, "sendReply");
    const forward = targetsOf(SRC, "sendForward");
    expect(reply.length, "the census found the reply send").toBeGreaterThan(0);
    expect(forward.length, "the census found the forward send").toBeGreaterThan(0);
    expect(new Set([...reply, ...forward])).toEqual(new Set(["m!.id"]));
  });

  it("one composer serves every reply mode, handed the reader's own message", () => {
    const mounts = mountsOf(SRC);
    const reader = mounts.filter((x) => x.mode === "{open.compose}");
    expect(reader, "one mount for reply, reply all and forward").toHaveLength(1);
    expect(reader[0]!.m).toBe("{m}");
    // Forward reads its id off the same `m` the reply presses open the composer over.
    expect(forwardOpensFor(SRC)).toBe("m.id");
  });

  it("a forward that resolves a member of its own reads as the refusal it is", () => {
    const own = SRC.replace(
      "await w.actions.sendForward(m!.id,",
      "await w.actions.sendForward(newestInThread(m!).id,",
    );
    expect(own).not.toBe(SRC);
    expect(new Set([...targetsOf(own, "sendReply"), ...targetsOf(own, "sendForward")]).size).toBe(2);
    const second = SRC.replace("const id = m.id;\n    const ask = m.forwardAsk;", "const id = newest.id;\n    const ask = m.forwardAsk;");
    expect(second).not.toBe(SRC);
    expect(forwardOpensFor(second)).not.toBe("m.id");
  });
});

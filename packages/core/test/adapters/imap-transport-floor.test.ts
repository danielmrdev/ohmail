import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { imapFlowOptions } from "../../src/adapters/imap.js";

/**
 * TWO PROPERTIES OF THE DIAL THAT ONLY ONE RUNTIME CAN NOTICE BREAKING.
 *
 * Both of these are correct on a server whatever they are set to, and both are the difference
 * between a working mailbox and an unopenable one where this adapter also runs. So neither can be
 * left to a default, and neither can be checked by running it here.
 */
const options = () => imapFlowOptions({
  host: "mail.example.test", port: 993, secure: true,
  auth: { user: "reader@example.test", pass: "secret" },
  smtp: { host: "mail.example.test", port: 465, secure: true },
  sentDomain: "example.test",
});

describe("the assembled dial", () => {
  it("refuses compression before the server can offer it", () => {
    // The client negotiates COMPRESS whenever the server advertises it, and compression is the one
    // step of its path that needs a whole compression library. Where there is none, the absence of
    // this option turns "this provider advertises DEFLATE" into a mailbox that will not open.
    expect(options().disableCompression).toBe(true);
  });

  it("carries the strict TLS parameters, so the option set is the floor", () => {
    const tls = options().tls as { rejectUnauthorized?: boolean; minVersion?: string };
    expect(tls.rejectUnauthorized).toBe(true);
    expect(tls.minVersion).toBe("TLSv1.2");
    expect(options().servername).toBe("mail.example.test");
  });

  it("reaches the pin through a leaf that carries no HTTP client", () => {
    // The pin and the outbound HTTP client shared a module, so importing one imported the other:
    // `node:http` and `node:https` reaching a program that has no implementation of either.
    // Splitting the pin out removes OUR module from that chain.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/adapters/imap.ts", import.meta.url)), "utf8",
    );
    expect(source).toContain('from "../net/pinned-lookup.js"');
    expect(source).not.toContain('from "../net/pinned-fetch.js"');
    expect(source, "the adapter must not reach an HTTP client directly either")
      .not.toMatch(/from "node:https?"/);

    const leaf = readFileSync(
      fileURLToPath(new URL("../../src/net/pinned-lookup.ts", import.meta.url)), "utf8",
    );
    expect(leaf).not.toMatch(/from "node:https?"/);
    // `node:net` may be reached for its TYPES only — a type import leaves nothing in a bundle.
    expect(leaf).toMatch(/import type \{[^}]*\} from "node:net"/);
  });

  it("does NOT claim the adapter is free of HTTP clients, because it is not", () => {
    // Stated as a test rather than a comment, because the comment above it was read as the
    // stronger claim and is not: the adapter imports the mail library's OAuth helper, which
    // requires that library's own fetch, which requires `http`, `https` and `zlib`. Splitting our
    // pin out does not change that and was never going to.
    //
    // What makes a runtime without those modules work is the bundle's thrower stubs, and what
    // keeps them unreached is that no mailbox in this product uses OAuth on that runtime. This
    // asserts the reach EXISTS so that nobody re-derives the stronger claim from the split, and
    // so a build that drops the stubs has a test naming the reason it cannot.
    const adapter = readFileSync(
      fileURLToPath(new URL("../../src/adapters/imap.ts", import.meta.url)), "utf8",
    );
    expect(adapter, "the OAuth helper is the path by which an HTTP client is still reachable")
      .toContain("nodemailer/lib/xoauth2");

    // Resolved, never spelled out: pnpm's directory for a PATCHED package carries the patch hash
    // (`nodemailer@8.0.11_patch_hash=…`), so a literal `.pnpm/<name>@<version>/` path stops
    // existing the moment anyone adds a patch for it — an ENOENT that reads as this test's subject
    // breaking rather than its fixture moving. `packages/core` declares nodemailer itself and the
    // library publishes no `exports` field, so the deep subpath resolves from this package.
    const xoauth = readFileSync(
      createRequire(import.meta.url).resolve("nodemailer/lib/xoauth2/index.js"), "utf8",
    );
    expect(xoauth, "and it reaches the client through the library's own fetch")
      .toContain(["require", "('../fetch')"].join(""));
  });
});

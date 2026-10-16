import { describe, expect, it, afterAll } from "vitest";
import { connect, createServer, type TLSSocket } from "node:tls";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeProbeFailure, probeCloudServer } from "../src/cloud-engine.js";
import { ensureLanIdentity, LAN_CERT_NAME } from "../src/host-lan-tls.js";

/**
 * THE ONE TLS REFUSAL WHOSE REMEDY IS MECHANICAL — a server whose certificate is for another
 * name — driven against a REAL TLS server presenting a REAL certificate, because the fields the
 * fix reads (`host`, `cert.subjectaltname`) are Node's and a hand-made error would be a claim
 * about Node rather than a measurement of it.
 *
 * The certificate is the LAN door's own, minted by `ensureLanIdentity`: it is for
 * `ohmail-desktop-host.invalid`, so ASKING for any other name is a genuine hostname mismatch, and
 * handing its certificate in as the `ca` is what makes the handshake fail on the NAME rather than
 * on the chain — the two are different refusals and the door says different things about them.
 *
 * The error is then wrapped the way `fetch` wraps a transport failure (`TypeError: fetch failed`
 * with the real error on `cause`), which is the shape the probe's classifier walks.
 */

const dir = mkdtempSync(join(tmpdir(), "ohmail-tls-names-"));
const minted = ensureLanIdentity(dir);
if (minted.kind !== "identity") throw new Error("the fixture could not mint a certificate");
const { key, cert } = minted.identity;

const server = createServer({ key, cert }, (socket: TLSSocket) => socket.end());
const listening = new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/** Dial the fixture asking for `servername`; resolves with what the handshake threw, or null. */
async function handshake(servername: string): Promise<unknown> {
  const port = await listening;
  return await new Promise<unknown>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, ca: cert, servername }, () => {
      socket.destroy();
      resolve(null);
    });
    socket.once("error", (err) => {
      socket.destroy();
      /* EXACTLY HOW `fetch` DELIVERS IT — the classifier walks `cause`, and a test that handed the
         bare error in would pass while production handed it a wrapper. */
      resolve(new TypeError("fetch failed", { cause: err }));
    });
  });
}

describe("a certificate for another name is refused BY NAME", () => {
  it("the handshake really fails, and on the NAME rather than the chain", async () => {
    const thrown = await handshake("mail.example.com");
    expect(thrown, "the fixture handshake succeeded — nothing below measures anything").not.toBeNull();
    const cause = (thrown as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("…AND the right name is accepted — the control on the case above", async () => {
    /* Without this, a fixture that refused every connection for any reason would carry the test. */
    expect(await handshake(LAN_CERT_NAME)).toBeNull();
  });

  it("the refusal names what was presented and what was asked for", async () => {
    const thrown = await handshake("mail.example.com");
    const [message, kind, more] = describeProbeFailure(thrown, "https://mail.example.com/api/hello");

    expect(kind).toBe("tls_name");
    expect(message).toContain(LAN_CERT_NAME);
    expect(message).toContain("mail.example.com");
    expect(more).toEqual({ tls: { presented: [LAN_CERT_NAME], requested: "mail.example.com" } });
  });

  it("and the probe's own answer carries them in details, beside the kind", async () => {
    const thrown = await handshake("mail.example.com");
    const res = await probeCloudServer(
      "https://mail.example.com/api",
      (async () => { throw thrown; }) as unknown as typeof fetch,
    );
    expect(res.status).toBe(502);
    const parsed = (await res.json()) as {
      error: { message: string; details: { kind: string; target: string; tls?: unknown } };
    };
    expect(parsed.error.details.kind).toBe("tls_name");
    expect(parsed.error.details.target).toBe("https://mail.example.com/api/hello");
    expect(parsed.error.details.tls)
      .toEqual({ presented: [LAN_CERT_NAME], requested: "mail.example.com" });
    expect(parsed.error.message).toContain(LAN_CERT_NAME);
  });

  it("nothing but names — no key, no fingerprint, no certificate bytes", async () => {
    const thrown = await handshake("mail.example.com");
    const [message, , more] = describeProbeFailure(thrown, "https://mail.example.com/api/hello");
    const whole = `${message} ${JSON.stringify(more)}`;
    for (const leak of ["BEGIN", "PRIVATE", "CERTIFICATE", "MII"]) {
      expect(whole, `the refusal carries ${leak}`).not.toContain(leak);
    }
  });

  it("the SAN is what is read, not the common name — they are not the same list", async () => {
    /* The fixture's certificate carries ONE name in both places, so the case above cannot tell a
       SAN read from a common-name read. `subjectaltname` is Node's own string form; this drives
       the parse of it with a SAN that DISAGREES with the CN, which is every real certificate
       issued for more than one name. */
    const thrown = new TypeError("fetch failed", {
      cause: Object.assign(new Error("altname"), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
        host: "mail.example.com",
        cert: {
          subjectaltname: "DNS:a.example.com, DNS:b.example.com, IP Address:10.0.0.7",
          subject: { CN: "never-read.example.com" },
        },
      }),
    });
    const [message, , more] = describeProbeFailure(thrown, "https://mail.example.com/api/hello");
    expect(more).toEqual({
      tls: {
        presented: ["a.example.com", "b.example.com", "10.0.0.7"],
        requested: "mail.example.com",
      },
    });
    expect(message).not.toContain("never-read.example.com");
    // The type prefix is dropped: the person is comparing this with what they typed.
    expect(message).not.toContain("DNS:");
  });

  it("a certificate for many names is truncated, not pasted", async () => {
    const many = Array.from({ length: 9 }, (_, i) => `DNS:h${i}.example.com`).join(", ");
    const thrown = new TypeError("fetch failed", {
      cause: Object.assign(new Error("altname"), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID", host: "mail.example.com",
        cert: { subjectaltname: many, subject: { CN: "h0.example.com" } },
      }),
    });
    const [message, , more] = describeProbeFailure(thrown, "https://mail.example.com/api/hello");
    expect((more as { tls: { presented: string[] } }).tls.presented).toHaveLength(9);
    expect(message).toContain("and 5 more");
    expect(message).not.toContain("h8.example.com");
  });

  it("a mismatch with NO certificate on the error falls back rather than saying nothing", async () => {
    /* The shape an older Node — or a proxy that re-raises the code alone — produces. The sentence
       has to stay actionable when there is nothing to name, and `details` must not grow an empty
       `tls` that a surface would render as a blank line. */
    const bare = new TypeError("fetch failed", {
      cause: Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    });
    const [message, kind, more] = describeProbeFailure(bare, "https://mail.example.com/api/hello");
    expect(kind).toBe("tls_name");
    expect(message).toContain("different name");
    expect(more).toBeUndefined();
  });
});

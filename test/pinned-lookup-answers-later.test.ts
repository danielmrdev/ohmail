import { describe, expect, it } from "vitest";
import tls from "node:tls";
import https from "node:https";
import { pinnedLookup } from "@trafficflow/core/net";

/**
 * THE PIN ANSWERS THE WAY A RESOLVER DOES: LATER. `dns.lookup` never calls back inside the call
 * that asked, and `tls.connect` relies on it: it dials inside its own body and then reads the
 * socket's handle for SNI. A pin that answers at once lets a connect that fails at once destroy
 * that handle first, so `tls.connect` THROWS a TypeError, the caller never receives the socket,
 * and the socket's own error is emitted with nobody listening. A bind to an address this machine
 * does not have fails at once and sends nothing; it stands for every connect that fails that way.
 */

const NOT_HERE = "203.0.113.9";

describe("a pinned lookup answers after the call that asked", () => {
  it("never calls back inside the lookup call", () => {
    let insideTheCall = true;
    let answeredInside: boolean | null = null;
    pinnedLookup(["127.0.0.1"])("mail.example.test", {}, () => { answeredInside = insideTheCall; });
    insideTheCall = false;
    expect(answeredInside, "a synchronous answer is the shape that crashes tls.connect").not.toBe(true);
  });

  it("a TLS dial whose pinned connect fails at once hands back a socket and reports the failure on it", async () => {
    let sock: tls.TLSSocket | null = null;
    let thrown: unknown = null;
    try {
      // `localAddress` reaches the socket's own connect; the TLS options type does not list it.
      sock = tls.connect({
        host: "localhost", port: 9, servername: "mail.example.test", localAddress: NOT_HERE,
        lookup: pinnedLookup(["127.0.0.1"]),
      } as tls.ConnectionOptions);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, "tls.connect threw instead of handing back the socket").toBeNull();
    const code = await new Promise<string>((resolve) => {
      sock!.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
    });
    expect(code).toBe("EADDRNOTAVAIL");
  });

  it("an HTTPS request whose pinned connect fails at once reports the failure on the request", async () => {
    let thrown: unknown = null;
    const code = await new Promise<string>((resolve) => {
      try {
        const req = https.request({
          host: "localhost", port: 9, path: "/", servername: "push.example.test", localAddress: NOT_HERE,
          lookup: pinnedLookup(["127.0.0.1"]),
        });
        req.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
        req.end();
      } catch (err) {
        thrown = err;
        resolve("threw");
      }
    });
    expect(thrown, "https.request threw instead of reporting on the request").toBeNull();
    expect(code).toBe("EADDRNOTAVAIL");
  });
});

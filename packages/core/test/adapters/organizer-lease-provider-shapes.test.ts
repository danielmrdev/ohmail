import { describe, expect, it } from "vitest";

import * as lease from "../../src/adapters/organizer-lease.js";
import { CORPUS, layoutOf, loadShape, providerMetaWorld, type ProviderShape } from "./_providershape.js";

const {
  CLAIM_PROTOCOL, META_RECORDS_MAX_PER_FETCH, formatAck, formatClaim, makeLeaseIo, makeLeasePeekIo,
  makeRequestOrganizerIo, readLeasePeek, runLeaseGate,
} = lease;

/**
 * The lease's presence reads over a full `ohmail/_meta`, once per RECORDED provider shape (row CI).
 * Past the newest-records window the election and the peek read claims by `HEADER X-Ohmail-Lease`,
 * and the ack sweep by `HEADER X-Ohmail-Ack`; a server that answers an empty-value HEADER term with
 * nothing read a live holder as nobody until every term carried the value its records hold
 * (`metaHeaderTerm`). Every shape must hold the property.
 */

const NOW = new Date("2026-09-04T12:00:00.000Z");
const ID = { installId: "test-install", mailboxId: "test-mailbox" };
const self = (): lease.LeaseSelf => ({ installId: "us", kind: "cloud", displayName: "Cloud", lastNonce: null });

function incumbentClaim(): string {
  return formatClaim({
    installId: "incumbent-install", kind: "local", displayName: "The Kitchen Mac",
    claimedAt: new Date(NOW.getTime() - 600_000), heartbeat: new Date(NOW.getTime() - 5_000),
    nonce: "incumbent-nonce", authorizedAt: new Date(NOW.getTime() - 600_000),
    capabilities: ["requests"], protocol: CLAIM_PROTOCOL,
  });
}

function worldOf(shape: ProviderShape) {
  const { prefix, delimiter, announce } = layoutOf(shape);
  const meta = `${prefix}ohmail${delimiter}_meta`;
  const server = providerMetaWorld(shape, {
    prefix, delimiter, announceNamespace: announce, folders: [`${prefix}ohmail`, meta],
  });
  const toServerPath = (canonical: string): string => canonical.split("/").join(delimiter);
  return { server, meta, toServerPath };
}

/** The holder's claim ON TOP of a folder past the window: the window itself does not reach it. */
function heldOverAFullFolder(shape: ProviderShape) {
  const w = worldOf(shape);
  for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 10; i++) w.server.seed(w.meta, `Subject: newsletter ${i}\r\n\r\nbody`);
  w.server.seed(w.meta, incumbentClaim());
  return w;
}

const appends = (w: ReturnType<typeof worldOf>): string[] => w.server.log.filter((l) => l.startsWith(`append ${w.meta}`));

/** Three acks past the cutoff and one live, then the sweep: how many did it remove? */
async function sweepOf(shape: ProviderShape): Promise<number> {
  const w = worldOf(shape);
  const key = "k".repeat(43);
  const old = new Date(NOW.getTime() - 72 * 3_600_000);
  const ack = (id: string, at: Date): string =>
    formatAck({ requestId: id, mailboxId: ID.mailboxId, outcome: "applied", ackedAt: at, key });
  for (let i = 0; i < 3; i++) w.server.seed(w.meta, ack(`stale-${i}`, old), old);
  w.server.seed(w.meta, ack("live", NOW), NOW);
  const io = makeRequestOrganizerIo(w.server, w.toServerPath, ID);
  if (io.sweepStaleAcks === undefined) throw new Error("this io has no sweepStaleAcks");
  return io.sweepStaleAcks(new Date(NOW.getTime() - 24 * 3_600_000));
}

describe("the corpus discriminates", () => {
  it("holds a shape that answers an empty-value HEADER with nothing and one that answers presence", () => {
    const modes = CORPUS.map((n) => loadShape(n).semantics.headerEmptyValue);
    expect(modes).toContain("nothing");
    expect(modes).toContain("presence");
  });

  it("counts Gmail's [THROTTLED] answers as transient, and the replay reads none of them", () => {
    const gmail = loadShape("gmail");
    expect(gmail.transient).toMatchObject({ of: 44, THROTTLED: 42 });
    expect(JSON.stringify(gmail.semantics)).not.toContain("THROTTLED");
    expect(gmail.semantics.headerEmptyValue).toBe("presence");
    expect(gmail.semantics.headerEmptyValueStandard).toBe("refused");
  });
});

for (const name of CORPUS) {
  const shape = loadShape(name);
  describe(`the lease reads a live holder on a ${name}-shaped server (${shape.source.kind})`, () => {
    it("the election over a full folder stands down and appends nothing", async () => {
      const w = heldOverAFullFolder(shape);
      const res = await runLeaseGate({
        capabilities: [], io: makeLeaseIo(w.server, w.toServerPath, ID), self: self(), now: NOW,
        newNonce: () => "n-us", log: () => undefined,
      });
      expect(res.verdict.verdict, `${name}: a live holder was read as nobody`).toBe("stand_down");
      expect(appends(w), `${name}: a second claim was appended`).toEqual([]);
    });

    it("the peek over a full folder names the holder", async () => {
      const w = heldOverAFullFolder(shape);
      const peek = await readLeasePeek({ io: makeLeasePeekIo(w.server, w.toServerPath), now: NOW });
      expect(peek.state, `${name}: the peek told a person nobody organizes the mailbox`).toBe("held");
      expect(peek.holders.map((h) => h.installId)).toEqual(["incumbent-install"]);
    });

    it("the ack sweep removes the stale acknowledgements and keeps the live one", async () => {
      expect(await sweepOf(shape), `${name}: the stale acknowledgements were not swept`).toBe(3);
    });
  });
}

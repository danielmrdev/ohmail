import { describe, expect, it } from "vitest";
import { memoryImapServer } from "./_metaworld.js";
import {
  makeLeaseIo, formatClaim, ClaimReleaseError, CLAIM_PROTOCOL, META_FOLDER,
} from "../../src/adapters/organizer-lease.js";

/**
 * ═══ A CLAIM IS DELETED BY UID, AND A UID IS A FACT ONLY UNDER ITS OWN NUMBERING ═══════════
 *
 * `REMOVECLAIMS-FAILS-OPEN-ON-UNKNOWN-GENERATION`. `removeClaims` refuses a PROVEN UIDVALIDITY
 * renumbering and proceeds when the generation is unknowable — and neither arm had ever been
 * watched. Eleven call sites hand it refs; a claim removed under a renumbered folder is somebody
 * else's claim deleted by uid coincidence.
 *
 * One case per arm, so a later author cannot move either without saying so:
 *
 *  · PROVEN mismatch (both generations known and different) → refuses, nothing expunged;
 *  · UNKNOWABLE (the connection hides UIDVALIDITY) → proceeds, and the justification is pinned
 *    here rather than living only in a comment: those refs came out of a read taken moments ago
 *    under the same selection, and the release path's confirm-by-re-read is the backstop a proof
 *    cannot supply. Flipping this arm closed would make a release impossible on a connection that
 *    never reports the generation, and "stop organizing here" must always be able to finish.
 */

const TEST_META_ID = { installId: "us", mailboxId: "mbx" };
const SERVER_PATH = "ohmail._meta";
const toServerPath = (c: string): string => c.split("/").join(".");
const NOW = new Date("2026-09-08T09:00:00.000Z");

const claimRaw = (installId: string): string => formatClaim({
  protocol: CLAIM_PROTOCOL, installId, kind: "local", displayName: `${installId} machine`,
  claimedAt: NOW, heartbeat: NOW, nonce: `n-${installId}`, authorizedAt: null, capabilities: [],
});

describe("removeClaims and the folder's numbering", () => {
  it("REFUSES a proven renumbering, and expunges nothing", async () => {
    const server = memoryImapServer({ folders: [SERVER_PATH] });
    server.seed(SERVER_PATH, claimRaw("us"));
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);

    // The read is what samples the generation the refs belong to.
    const records = await io.listClaims();
    expect(records).toHaveLength(1);

    // The one thing that moves UIDVALIDITY: the folder is replaced under us. A stranger's claim now
    // sits at the uid our ref names.
    server.renumber(SERVER_PATH);
    server.seed(SERVER_PATH, claimRaw("stranger"));

    const err = await io.removeClaims(records.map((r) => r.ref))
      .then(() => null, (e: unknown) => e);
    expect(err, "a stale map was used to delete by uid").toBeInstanceOf(ClaimReleaseError);
    expect((err as { code: string }).code).toBe("renumbered");
    expect((err as Error).message).toContain(META_FOLDER);

    // THE WHOLE POINT: the stranger's claim is still there.
    const left = server.tree.get(SERVER_PATH)!.messages.map((m) => m.raw).join("\n");
    expect(left, "the refused delete took a stranger's claim with it").toContain("stranger");
  });

  it("PROCEEDS when the connection hides the generation — the decided fail-open arm", async () => {
    const server = memoryImapServer({ folders: [SERVER_PATH] });
    server.seed(SERVER_PATH, claimRaw("us"));
    // A connection that answers NAMESPACE and SELECT but reports no UIDVALIDITY at all. Its refs
    // are still current: nothing has re-selected the folder between the read and the delete.
    const blind = new Proxy(server, {
      get(target, prop, recv) {
        if (prop === "mailbox") {
          const m = Reflect.get(target, prop, recv) as { exists?: number } | false;
          return m === false ? false : { exists: m.exists };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof server;

    const io = makeLeaseIo(blind, toServerPath, TEST_META_ID);
    const records = await io.listClaims();
    await expect(io.removeClaims(records.map((r) => r.ref)),
      "a release became impossible on a connection that never reports the generation")
      .resolves.toBeUndefined();
    expect(server.tree.get(SERVER_PATH)!.messages,
      "the fail-open arm expunged nothing").toHaveLength(0);
  });

  /**
   * —— AND A `0` IS THE UNKNOWABLE ARM, NOT THE PROVEN ONE ———————————————————————————
   *
   * The refusal was written as `String(gen) !== String(generationAtLastRead)` behind two null
   * checks, so a server that REPORTS the field with nothing in it — `0`, which is not a
   * UIDVALIDITY — read as a named generation. A read under `0` followed by a real one then looked
   * like a proven renumbering, and this install could never finish "stop organizing here" on that
   * connection: every release refused, and the claim it could not remove obstructs the next
   * organizer for the whole staleness window. Through `epoch.ts` the two spellings of "no epoch"
   * are one state, and one state takes the decided fail-open arm.
   *
   * MUTATION WATCHED RED (2026-09-12, restore verified by `cmp`): the guard back to the two null
   * checks ⇒ this reddens with a `ClaimReleaseError` and the folder still holding our claim.
   */
  it("PROCEEDS when the generation is reported as a zero — not a proven renumbering", async () => {
    const server = memoryImapServer({ folders: [SERVER_PATH] });
    server.seed(SERVER_PATH, claimRaw("us"));
    // Reports `0` for the read that samples the generation, then a real one at the delete.
    let reported: number | undefined = 0;
    const vague = new Proxy(server, {
      get(target, prop, recv) {
        if (prop === "mailbox") {
          const m = Reflect.get(target, prop, recv) as { exists?: number } | false;
          return m === false ? false : { exists: m.exists, uidValidity: reported };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof server;

    const io = makeLeaseIo(vague, toServerPath, TEST_META_ID);
    const records = await io.listClaims();
    reported = 1_000;

    await expect(io.removeClaims(records.map((r) => r.ref)),
      "a zero read as a named generation made every release on this connection impossible")
      .resolves.toBeUndefined();
    expect(server.tree.get(SERVER_PATH)!.messages).toHaveLength(0);
  });

  it("proceeds when the generation is KNOWN and UNCHANGED — the positive control", async () => {
    const server = memoryImapServer({ folders: [SERVER_PATH] });
    server.seed(SERVER_PATH, claimRaw("us"));
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);
    const records = await io.listClaims();
    await expect(io.removeClaims(records.map((r) => r.ref))).resolves.toBeUndefined();
    expect(server.tree.get(SERVER_PATH)!.messages,
      "the refusal fires on a folder nothing happened to").toHaveLength(0);
  });
});

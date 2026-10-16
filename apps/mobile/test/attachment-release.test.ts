/**
 * ═══ THE READER RELEASES THE FILE BYTES IT ASKED FOR ═════════════════════════════════════════
 *
 * The engine holds a message's file list, its inline pictures and every Blob a tile press
 * fetched until somebody releases them — nothing prunes that map by policy. The web seam
 * releases on unmount, keyed on the open message; the phone mints no object URL, so no
 * revocation stands in for the release, and without one a session grows by every rich message
 * it was shown.
 */

/*
 * Who asks and who releases is pinned in the root attachment-url revocation census; these arms
 * drive the path itself — the app's own chain down to the engine, the world provider above it,
 * and the reader's cleanup. This workspace has no React Native renderer, so wiring is read
 * where it is real: the component source, at a rendered call and never at a comment.
 *
 * MUTATIONS WATCHED (parked and restored through `mutation-control.sh`):
 * `live.ts`'s stableActions forwarding removed ⇒ the chain arm RED; `world.tsx`'s forwarding
 * removed ⇒ the provider arm RED; `MessageReader.tsx`'s cleanup removed ⇒ the reader arm RED.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, stableActions, type LiveWorldActions } from "../src/state/live";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/* @reads: apps/mobile/src/ui/MessageReader.tsx apps/mobile/src/state/world.tsx
   Read by a path built at runtime, so no landing pass selects this file when that source
   moves — the shape `reads-list.mjs` exists for. */

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READER = readFileSync(join(APP, "src/ui/MessageReader.tsx"), "utf8");
const WORLD = readFileSync(join(APP, "src/state/world.tsx"), "utf8");

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

describe("the phone's release reaches the engine through the app's own chain", () => {
  it("stableActions over the live layer calls the engine's releaseAttachments with that id", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.addMessage(dto("m1", { subject: "Welcome" }));
      const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
      if (boot.kind !== "ready") throw new Error("boot refused");
      await boot.verifyIdentity();
      await boot.engine.start();
      /* The REAL engine method, with a counter around it — a double that answered differently is
         how the compose defect stayed green, so this passes every call through. */
      const released: string[] = [];
      const real = boot.engine.releaseAttachments.bind(boot.engine);
      boot.engine.releaseAttachments = (id: string) => {
        released.push(id);
        real(id);
      };
      const actions: LiveWorldActions = liveActions({
        engine: boot.engine,
        toast: (m) => void sayArg(m),
        uuid: deps.uuid,
        zone: "UTC",
      });
      stableActions(() => actions as never).releaseAttachments("m1");
      expect(released).toEqual(["m1"]);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("the world provider forwards the release", () => {
  it("the live branch hands it to the live layer, and the empty world answers it", () => {
    // The provider sits above `stableActions`, so the chain arm above cannot see this line: a
    // provider that forwarded every other verb and not this one would leave the reader's cleanup
    // calling the empty world's no-op for the whole of a live session.
    expect(WORLD).toContain("releaseAttachments: (id) => acts.releaseAttachments(id),");
    expect(WORLD).toContain("releaseAttachments: () => undefined,");
  });
});

describe("the reader's open effect owns the cleanup", () => {
  it("returns a cleanup that releases the id it opened", () => {
    expect(READER).toContain("const releaseAttachments = w.actions.releaseAttachments;");
    expect(READER).toMatch(/return \(\) => \{\s*if \(id\) releaseAttachments\(id\);\s*\};/);
  });

  it("the cleanup is in the SAME effect as the open, and that effect depends on both", () => {
    // One effect, one id: a release keyed on a different dependency list would drop the bytes of
    // a message still on screen, or keep the bytes of one long gone.
    expect(READER).toContain("if (id) openMessage(id);");
    expect(READER).toContain("}, [id, openMessage, releaseAttachments, worldKey]);");
  });
});

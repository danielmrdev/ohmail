import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowOutbox, WINDOW_OUTBOX_ROUTE, windowOutboxFilesOf, windowOutboxOwnerKey } from "../src/window-outbox.js";

/**
 * A power cut, modelled over the real calls in one directory. A file's bytes reach the disk when
 * its handle is flushed; a name, made by a rename or removed by an unlink, when the DIRECTORY is
 * flushed. `cut()` lays the directory back to what had reached the disk, and a fresh door reads
 * that, as the next launch would.
 */
interface Inode { bytes: string; flushed: string | null }
let disk: { dir: string; names: Map<string, Inode>; onDisk: Map<string, Inode> } | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const nameIn = (p: unknown): string | null =>
    disk !== null && dirname(String(p)) === disk.dir ? basename(String(p)) : null;
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const m = disk;
      if (m === null) return handle;
      const sync = handle.sync.bind(handle);
      if (String(args[0]) === m.dir) {
        handle.sync = async () => { await sync(); m.onDisk = new Map(m.names); };
        return handle;
      }
      const name = nameIn(args[0]);
      if (name === null || args[1] !== "w") return handle;
      const inode: Inode = m.names.get(name) ?? { bytes: "", flushed: null };
      inode.bytes = "";
      m.names.set(name, inode);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...w: Parameters<typeof handle.writeFile>) => { await write(...w); inode.bytes += String(w[0]); };
      handle.sync = async () => { await sync(); inode.flushed = inode.bytes; };
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      const from = nameIn(args[0]);
      const to = nameIn(args[1]);
      if (disk === null || from === null || to === null) return;
      const inode = disk.names.get(from);
      disk.names.delete(from);
      if (inode) disk.names.set(to, inode);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      await actual.unlink(...args);
      const name = nameIn(args[0]);
      if (disk !== null && name !== null) disk.names.delete(name);
    },
  };
});

/** Arm the model on a directory: what is in it now is on the disk. */
function arm(dir: string): void {
  const names = new Map<string, Inode>();
  for (const f of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, f), "utf8");
    names.set(f, { bytes, flushed: bytes });
  }
  disk = { dir, names, onDisk: new Map(names) };
}

/** The power cut: only names the directory flush recorded, each with only its flushed bytes. */
function cut(): void {
  const m = disk!;
  disk = null;
  for (const f of readdirSync(m.dir)) rmSync(join(m.dir, f));
  for (const [name, inode] of m.onDisk) writeFileSync(join(m.dir, name), inode.flushed ?? "");
}

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-window-outbox-cut-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  disk = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SERVED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = { address: "me@ohmail.test", base: "https://cloud.test" };
const OUTBOX_FILE = windowOutboxFilesOf(windowOutboxOwnerKey(OWNER))[0]!;
function door(dir: string) {
  const d = createWindowOutbox({
    dataDir: dir, owner: OWNER, authorized: async () => true, scope: () => SERVED, log: () => undefined,
  });
  const at = `http://sidecar${WINDOW_OUTBOX_ROUTE}?scope=${SERVED}`;
  return {
    post: async (body: unknown) => (await d.handle(new Request(at, { method: "POST", body: JSON.stringify(body) }))).status,
    ids: async () => ((await (await d.handle(new Request(at))).json()) as { rows: Array<{ id: string }> }).rows.map((r) => r.id).sort(),
  };
}
const entry = (id: string) => ({
  type: "outbox_entry", id, entity: { v: 3, id, key: `k-${id}`, n: 1, at: 1, mutation: { kind: "mark_seen" } },
});

describe.skipIf(process.platform === "win32")("the window's outbox after a power cut", () => {
  it("the model: a removal nobody flushed comes back, a flushed one stays gone", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "kept"), "one");
    writeFileSync(join(dir, "gone"), "two");
    arm(dir);
    await unlink(join(dir, "kept"));
    cut();
    expect(readFileSync(join(dir, "kept"), "utf8"), "an unflushed removal is not on the disk").toBe("one");
    arm(dir);
    await unlink(join(dir, "gone"));
    const handle = await open(dir, "r");
    await handle.sync();
    await handle.close();
    cut();
    expect(existsSync(join(dir, "gone")), "a flushed removal is").toBe(false);
  });

  it("a kept change is on the disk when the door answers", async () => {
    const dir = tempDir();
    arm(dir);
    const d = door(dir);
    expect(await d.post({ puts: [entry("a")] })).toBe(204);
    expect(await d.post({ puts: [entry("b")] })).toBe(204);
    cut();
    expect(await door(dir).ids()).toEqual(["a", "b"]);
  });

  it("an emptied outbox is empty on the disk when the door answers", async () => {
    const dir = tempDir();
    arm(dir);
    const d = door(dir);
    expect(await d.post({ puts: [entry("a")] })).toBe(204);
    expect(await d.post({ deletes: [{ type: "outbox_entry", id: "a" }] })).toBe(204);
    cut();
    expect(await door(dir).ids(), "the sent change is not offered again").toEqual([]);
    expect(existsSync(join(dir, OUTBOX_FILE))).toBe(false);
  });
});

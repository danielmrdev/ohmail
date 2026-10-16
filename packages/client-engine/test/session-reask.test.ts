import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionReask,
  sessionRefused,
  STORE_ANSWER_TIMEOUT_MS,
  type SessionRenewalDoor,
  type StoreReadSource,
} from "../src/index.js";

/**
 * THE ONE RE-ASK RULE, on a virtual clock: a store read refused by the session asks one renewal,
 * counts as loading while it is out, and is asked again once per renewal. The browser binds it to
 * its refresh and the phone to its bearer; both read these cases.
 */

function fakeRead(): StoreReadSource & { set(cause: string | null, answered?: boolean): void; asked: number } {
  const listeners = new Set<() => void>();
  let cause: string | null = null;
  let answered = false;
  const read = {
    asked: 0,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    cause: () => cause,
    answered: () => answered,
    reask: () => { read.asked += 1; read.set(null); },
    set(next: string | null, isAnswered = false) {
      cause = next;
      answered = isAnswered;
      for (const l of [...listeners]) l();
    },
  };
  return read;
}

function fakeDoor(): SessionRenewalDoor & { renewals: number; renewed(): void; dead: boolean } {
  const listeners = new Set<() => void>();
  const door = {
    renewals: 0,
    dead: false,
    renew: () => { door.renewals += 1; },
    onRenewed: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    ended: () => door.dead,
    renewed: () => { for (const l of [...listeners]) l(); },
  };
  return door;
}

const REFUSED = "MutationRejectedError 401 unauthorized";
const FAULT = "MutationRejectedError 503 db_busy";

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("a store read over a session renewal", () => {
  it("a 401 asks ONE renewal, reads as loading, and is asked again once the renewal lands", () => {
    const door = fakeDoor();
    const read = fakeRead();
    const rule = createSessionReask(door, read);
    rule.attach();
    read.set(REFUSED);
    expect(rule.renewing(), "a refused session read as a silent server").toBe(true);
    expect(door.renewals).toBe(1);
    read.set(REFUSED);
    expect(door.renewals, "the same refusal asked twice").toBe(1);
    door.renewed();
    expect(read.asked, "no second ask after the renewal").toBe(1);
    read.set(null, true);
    expect(rule.renewing()).toBe(false);
  });

  it("CONTROL — a server fault is said at once: no renewal asked, no re-ask", () => {
    const door = fakeDoor();
    const read = fakeRead();
    const rule = createSessionReask(door, read);
    rule.attach();
    read.set(FAULT);
    expect(rule.renewing()).toBe(false);
    door.renewed();
    expect(door.renewals).toBe(0);
    expect(read.asked).toBe(0);
  });

  it("refused again after the renewal, it says so and asks for no second renewal", () => {
    const door = fakeDoor();
    const read = fakeRead();
    const rule = createSessionReask(door, read);
    rule.attach();
    read.set(REFUSED);
    door.renewed();
    read.set(REFUSED);
    expect(rule.renewing(), "a server refusing every session kept the read loading").toBe(false);
    expect(door.renewals, "a server refusing every session drove a refresh loop").toBe(1);
  });

  it("a renewal that never answers ends at the store's own ceiling", () => {
    const door = fakeDoor();
    const read = fakeRead();
    const rule = createSessionReask(door, read);
    rule.attach();
    read.set(REFUSED);
    vi.advanceTimersByTime(STORE_ANSWER_TIMEOUT_MS - 1);
    expect(rule.renewing()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(rule.renewing()).toBe(false);
  });

  it("a renewal after the ceiling still asks again: the read comes back when the session does", () => {
    const door = fakeDoor();
    const read = fakeRead();
    const rule = createSessionReask(door, read);
    rule.attach();
    read.set(REFUSED);
    vi.advanceTimersByTime(STORE_ANSWER_TIMEOUT_MS);
    door.renewed();
    expect(read.asked).toBe(1);
  });

  it("a person's Try again after the sentence buys one more renewal, not a loop", () => {
    const door = fakeDoor();
    const read = fakeRead();
    const rule = createSessionReask(door, read);
    rule.attach();
    read.set(REFUSED);
    door.renewed();
    read.set(REFUSED);
    read.set(null);
    read.set(REFUSED);
    expect(door.renewals).toBe(2);
    expect(rule.renewing()).toBe(true);
  });

  it("a confirmed dead session and a door with no session are said at once", () => {
    const dead = fakeDoor();
    dead.dead = true;
    const read = fakeRead();
    const rule = createSessionReask(dead, read);
    rule.attach();
    read.set(REFUSED);
    expect(rule.renewing()).toBe(false);
    const none = fakeRead();
    const bare = createSessionReask(null, none);
    bare.attach();
    none.set(REFUSED);
    expect(bare.renewing()).toBe(false);
  });

  it("detached, it neither re-asks nor keeps a timer; attached again it reads the read afresh", () => {
    const door = fakeDoor();
    const read = fakeRead();
    const rule = createSessionReask(door, read);
    const stop = rule.attach();
    read.set(REFUSED);
    stop();
    door.renewed();
    expect(read.asked).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    rule.attach();
    expect(door.renewals, "a re-attach asked a second renewal for one refusal").toBe(1);
    expect(vi.getTimerCount(), "the re-attached wait has no ceiling").toBe(1);
  });

  it("the refusal class is the status word, never a digit run inside another", () => {
    expect(sessionRefused(REFUSED)).toBe(true);
    expect(sessionRefused("MutationRejectedError 4010 x")).toBe(false);
    expect(sessionRefused(null)).toBe(false);
  });
});

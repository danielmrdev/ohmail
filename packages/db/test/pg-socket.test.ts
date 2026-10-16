import { describe, it, expect } from "vitest";
import { isProtocolOpener, pgSocket, withPgSocket } from "../src/pg-socket.js";

/**
 * The rule `pgSocket` dials on: a connection's FIRST packet is exactly one protocol opener. The
 * stale bytes postgres.js@3.4.9 flushes ahead of a handshake start with a message-type letter, so
 * their length word is never the packet's length. The pool-level reading, through a real driver
 * and a real server, is `pool-wedge.pg.test.ts`.
 */

function packet(len: number, code: number, total = len): Buffer {
  const b = Buffer.alloc(Math.max(len, 8));
  b.writeInt32BE(len, 0);
  b.writeInt32BE(code, 4);
  return b.subarray(0, total);
}

describe("isProtocolOpener", () => {
  it("admits each opener the driver can send, as a whole packet", () => {
    expect(isProtocolOpener(packet(201, 196_608)), "a protocol 3.0 startup").toBe(true);
    expect(isProtocolOpener(packet(8, 80_877_103)), "an SSLRequest").toBe(true);
    expect(isProtocolOpener(packet(8, 80_877_104)), "a GSSENCRequest").toBe(true);
    expect(isProtocolOpener(packet(16, 80_877_102)), "a CancelRequest").toBe(true);
  });

  it("refuses stale statement bytes, a truncated opener, an opener with bytes behind it, and non-bytes", () => {
    const parse = Buffer.concat([Buffer.from("P"), Buffer.alloc(40)]);
    expect(isProtocolOpener(parse), "a Parse message").toBe(false);
    expect(isProtocolOpener(Buffer.concat([parse, packet(201, 196_608)])), "stale bytes then a startup").toBe(false);
    expect(isProtocolOpener(Buffer.from("X\0\0\0\u0004")), "a Terminate").toBe(false);
    expect(isProtocolOpener(packet(201, 196_608, 7)), "shorter than the header").toBe(false);
    expect(isProtocolOpener(packet(201, 196_608, 150)), "a startup cut short").toBe(false);
    expect(isProtocolOpener(Buffer.concat([packet(8, 80_877_103), Buffer.alloc(4)])), "an opener with bytes behind it").toBe(false);
    expect(isProtocolOpener(packet(201, 196_610)), "an unknown protocol code").toBe(false);
    expect(isProtocolOpener("SSLRequest"), "a string").toBe(false);
  });
});

describe("pgSocket", () => {
  it("does not dial until the driver writes, and never dials for a first write that is not an opener", async () => {
    const socket = pgSocket({ host: ["127.0.0.1"], port: [1] });
    expect(socket.connecting, "dialed before the driver wrote").toBe(false);
    const closed = new Promise<void>((r) => { socket.once("close", () => { r(); }); });
    expect(socket.write(Buffer.from("X\0\0\0\u0004")), "the stale write was accepted").toBe(false);
    expect(socket.connecting, "a non-opener dialed the server").toBe(false);
    await closed;
  });

  it("closes a socket the driver never wrote to, and leaves the driver's host on it for SNI", async () => {
    const socket = pgSocket({ host: ["db.example.test"], port: [5432] });
    expect((socket as unknown as { host: string }).host).toBe("db.example.test");
    await new Promise<void>((r) => { socket.once("close", () => { r(); }); });
    expect(socket.destroyed).toBe(true);
  });

  it("is attached to an options object without replacing it", () => {
    const opts = { max: 1 };
    expect(withPgSocket(opts)).toBe(opts);
    expect((opts as { socket?: unknown }).socket).toBe(pgSocket);
  });
});

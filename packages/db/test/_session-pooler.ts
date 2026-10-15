import net from "node:net";
import tls from "node:tls";

/**
 * A SESSION-MODE POOLER OF ONE BACKEND: every client after the first is handed the SAME Postgres
 * session, set the way the last client left it, which is what a session pooler does between
 * clients. The first client's startup goes through with `options` appended (a role's defaults, given
 * at startup so no role is altered); its Terminate is swallowed and the backend kept; each later
 * client gets the recorded AuthenticationOk…ReadyForQuery. An SSLRequest is answered `S` with `tls`.
 */
export interface SessionPooler {
  readonly port: number;
  /** Clients that have connected so far. */
  clients(): number;
  close(): Promise<void>;
}

const SSL_REQUEST = 80_877_103;
const PROTOCOL_3 = 196_608;

type Leg = net.Socket | tls.TLSSocket;

/** The first length-prefixed packet off a stream, and whatever arrived behind it. */
function firstPacket(sock: Leg): Promise<{ packet: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const n = buf.readInt32BE(0);
      if (buf.length < n) return;
      sock.off("data", onData);
      sock.pause();
      resolve({ packet: buf.subarray(0, n), rest: buf.subarray(n) });
    };
    sock.on("data", onData);
    sock.once("error", reject);
  });
}

/** A StartupMessage with `options` appended to whatever the client sent. */
function withOptions(startup: Buffer, options: string): Buffer {
  const fields = startup.subarray(8, startup.length - 1).toString("utf8").split("\0");
  const kv = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) kv.set(fields[i]!, fields[i + 1]!);
  kv.set("options", [kv.get("options"), options].filter(Boolean).join(" "));
  const body = Buffer.from([...kv].map(([k, v]) => `${k}\0${v}\0`).join("") + "\0", "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32BE(8 + body.length, 0);
  head.writeInt32BE(PROTOCOL_3, 4);
  return Buffer.concat([head, body]);
}

/** Frames of the typed protocol (type byte + int32 length), fed as bytes arrive. */
function framer(onFrame: (type: string, frame: Buffer) => void): (d: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
      const n = 1 + buf.readInt32BE(1);
      if (buf.length < n) return;
      onFrame(String.fromCharCode(buf[0]!), buf.subarray(0, n));
      buf = buf.subarray(n);
    }
  };
}

export async function sessionPooler(
  target: { host: string; port: number },
  opts: { options?: string; tls?: { key: string; cert: string } } = {},
): Promise<SessionPooler> {
  let backend: net.Socket | null = null;
  let tail: Buffer | null = null;
  const pending: Array<(t: Buffer) => void> = [];
  let current: Leg | null = null;
  let clients = 0;
  const live = new Set<Leg>();

  const toBackend = (sock: Leg): ((d: Buffer) => void) => framer((type, frame) => {
    if (type === "X") { if (current === sock) current = null; sock.end(); return; }
    backend?.write(frame);
  });

  const attach = (sock: Leg, startup: Buffer, rest: Buffer): void => {
    if (startup.readInt32BE(4) !== PROTOCOL_3) { sock.destroy(); return; }
    current = sock;
    sock.on("close", () => { if (current === sock) current = null; });
    const feed = toBackend(sock);
    const go = (): void => { if (rest.length) feed(rest); sock.on("data", feed); sock.resume(); };
    if (backend === null) {
      backend = net.createConnection(target);
      live.add(backend);
      let capturing = false;
      let captured = Buffer.alloc(0);
      const capture = framer((type, frame) => {
        if (!capturing && type === "R" && frame.length === 9 && frame.readInt32BE(5) === 0) capturing = true;
        if (capturing) captured = Buffer.concat([captured, frame]);
        if (capturing && type === "Z" && tail === null) { tail = captured; for (const p of pending.splice(0)) p(captured); }
      });
      backend.on("data", (d: Buffer) => { if (tail === null) capture(d); current?.write(d); });
      backend.on("error", () => { for (const s of live) s.destroy(); });
      backend.write(opts.options ? withOptions(startup, opts.options) : startup);
      go();
      return;
    }
    const hand = (t: Buffer): void => { sock.write(t); go(); };
    if (tail) hand(tail); else pending.push(hand);
  };

  const server = net.createServer((raw) => {
    clients += 1;
    live.add(raw);
    raw.on("error", () => raw.destroy());
    void (async () => {
      let sock: Leg = raw;
      let { packet, rest } = await firstPacket(raw);
      if (packet.readInt32BE(4) === SSL_REQUEST) {
        if (opts.tls) {
          raw.write("S");
          const secure = new tls.TLSSocket(raw, { isServer: true, key: opts.tls.key, cert: opts.tls.cert });
          secure.on("error", () => raw.destroy());
          live.add(secure);
          sock = secure;
        } else {
          raw.write("N");
        }
        sock.resume();
        ({ packet, rest } = await firstPacket(sock));
      }
      attach(sock, packet, rest);
    })().catch(() => raw.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    port,
    clients: () => clients,
    close: async () => {
      for (const s of live) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";

/**
 * THE PHONE'S PLATFORM SOCKET, OFF-DEVICE — `react-native-tcp-socket` as the shims meet it, over
 * real node sockets. The rules kept are the ones the device showed: ONE receiver per connection
 * whose bytes reach EVERY JavaScript socket on that connection (an upgrade adds a second one), a
 * pause from ANY of them pauses that shared receiver, and a STARTTLS upgrade announces nothing —
 * its peer certificate answers only once the handshake is done.
 */
interface Conn { raw: net.Socket; paused: boolean; held: Buffer[]; sockets: Set<PlatformSocket>; pauses: number }

export class PlatformSocket extends EventEmitter {
  _paused = false;
  private own: Buffer[] = [];
  constructor(readonly conn: Conn) {
    super();
    conn.sockets.add(this);
  }
  deliver(b: Buffer): void {
    if (this._paused) this.own.push(b);
    else this.emit("data", b);
  }
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    this.conn.paused = true;
    this.conn.pauses += 1;
    this.conn.raw.pause();
  }
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    for (const b of this.own.splice(0)) this.emit("data", b);
    this.conn.paused = false;
    for (const b of this.conn.held.splice(0)) dispatch(this.conn, b);
    this.conn.raw.resume();
  }
  write(chunk: Buffer, _enc: unknown, cb?: (e?: Error) => void): boolean {
    return this.conn.raw.write(chunk, (e) => cb?.(e ?? undefined));
  }
  end(): void { this.conn.raw.end(); }
  destroy(): void { this.conn.raw.destroy(); }
  setKeepAlive(): this { return this; }
  setNoDelay(): this { return this; }
  setTimeout(): this { return this; }
  address(): object { return {}; }
  getPeerCertificate(): Promise<object> { return Promise.resolve({}); }
}

/** Over a SNAPSHOT, as React Native's emitter does: a socket joining mid-delivery gets later bytes. */
function dispatch(conn: Conn, b: Buffer): void {
  if (conn.paused) { conn.held.push(b); return; }
  for (const s of [...conn.sockets]) s.deliver(b);
}

function wire(conn: Conn, raw: net.Socket): void {
  raw.on("data", (b: Buffer) => dispatch(conn, b));
  raw.on("error", (e) => { for (const s of [...conn.sockets]) s.emit("error", e.message); });
  raw.on("close", () => { for (const s of [...conn.sockets]) s.emit("close", false); });
}

/** The TLS socket an upgrade hands back: the SAME connection, a second JavaScript socket on it. */
class UpgradedSocket extends PlatformSocket {
  private readonly done: Promise<object>;
  constructor(under: PlatformSocket, options: { servername?: string; ca?: string }, ca: string) {
    super(under.conn);
    const plain = under.conn.raw;
    plain.removeAllListeners("data");
    const secure = tls.connect({ socket: plain, servername: options.servername ?? "localhost", ca, rejectUnauthorized: true });
    under.conn.raw = secure;
    this.done = new Promise((resolve) => {
      secure.once("secureConnect", () => resolve(secure.getPeerCertificate() as object));
      secure.once("error", () => resolve({}));
    });
    wire(under.conn, secure);
  }
  override getPeerCertificate(): Promise<object> { return this.done; }
}

/** The module the shims `require`, bound to a test CA. `conns` is every connection it opened. */
export function platformDouble(ca: string): { module: object; conns: Conn[] } {
  const conns: Conn[] = [];
  const open = (raw: net.Socket): PlatformSocket => {
    const conn: Conn = { raw, paused: false, held: [], sockets: new Set(), pauses: 0 };
    conns.push(conn);
    wire(conn, raw);
    return new PlatformSocket(conn);
  };
  return {
    conns,
    module: {
      createConnection: (o: { host: string; port: number }) => {
        const s = open(net.connect(o.port, o.host));
        s.conn.raw.once("connect", () => s.emit("connect"));
        return s;
      },
      connectTLS: (o: { host: string; port: number; servername?: string }) => {
        const raw = tls.connect({ host: o.host, port: o.port, servername: o.servername ?? "localhost", ca, rejectUnauthorized: true });
        const s = open(raw);
        raw.once("secureConnect", () => { s.emit("connect"); s.emit("secureConnect"); });
        return s;
      },
      TLSSocket: class { constructor(under: PlatformSocket, o: { servername?: string }) { return new UpgradedSocket(under, o, ca) as never; } },
      isIP: (h: string) => net.isIP(h), isIPv4: (h: string) => net.isIPv4(h), isIPv6: (h: string) => net.isIPv6(h),
    },
  };
}

import net from "node:net";

/**
 * A TCP relay in front of a real IMAP server that makes it misbehave in the three ways the
 * settings writer must survive: a header SEARCH that finds nothing (the iCloud shape), an EXPUNGE
 * the server refuses, and a server without UIDPLUS. It answers the refused commands ITSELF, only
 * at a response-line boundary, and counts what it did, so a green through it is a relay that fired.
 */
export interface MetaRelayOptions {
  /** Answer every `SEARCH` / `UID SEARCH` naming `HEADER` with an empty `* SEARCH`. */
  blindHeaderSearch?: boolean;
  /** Answer `EXPUNGE` / `UID EXPUNGE` with `NO`; the STORE before it still reaches the server. */
  refuseExpunge?: boolean;
  /** Strip `UIDPLUS` from every capability list and `APPENDUID` / `COPYUID` from every reply. */
  stripUidplus?: boolean;
  /**
   * Rewrite the value of every `HEADER <name> <value>` term in a SEARCH (atom or quoted) to this
   * value, which no record carries: the server answers honestly, and a header search finds nothing.
   * A LITERAL value drops the connection, so a spelling the rewrite cannot see fails the case.
   */
  rewriteHeaderValues?: string;
}

export interface MetaRelay {
  port: number;
  /** Header searches answered empty by the relay. */
  readonly searchesBlinded: number;
  /** Expunges answered NO by the relay. */
  readonly expungesRefused: number;
  /** Capability lists and APPENDUID/COPYUID codes rewritten. */
  readonly uidplusStripped: number;
  /** HEADER term values rewritten, and SEARCH commands dropped for carrying a literal value. */
  readonly valuesRewritten: number;
  readonly literalValues: number;
  /** Turn a mode off for the connections still open, the "healed" server. */
  heal(mode: keyof MetaRelayOptions): void;
  close(): Promise<void>;
}

/** One direction's framing: whole lines, and literals passed through byte for byte. */
function framer(onLine: (line: string) => void, onLiteral: (bytes: Buffer) => void): {
  push(chunk: Buffer): void; atBoundary(): boolean;
} {
  let pending = Buffer.alloc(0);
  let literal = 0;
  return {
    push(chunk: Buffer): void {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (literal > 0) {
          const take = Math.min(literal, pending.length);
          if (take === 0) break;
          onLiteral(pending.subarray(0, take));
          pending = pending.subarray(take);
          literal -= take;
          continue;
        }
        const nl = pending.indexOf("\r\n");
        if (nl === -1) break;
        const line = pending.subarray(0, nl).toString("latin1");
        pending = pending.subarray(nl + 2);
        onLine(line);
        const lit = /\{(\d+)\+?\}$/.exec(line);
        if (lit) literal = Number(lit[1]);
      }
    },
    atBoundary: (): boolean => literal === 0 && pending.length === 0,
  };
}

export async function metaRelay(
  target: { host: string; port: number }, opts: MetaRelayOptions,
): Promise<MetaRelay> {
  const mode: MetaRelayOptions = { ...opts };
  let searchesBlinded = 0;
  let expungesRefused = 0;
  let uidplusStripped = 0;
  let valuesRewritten = 0;
  let literalValues = 0;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client); sockets.add(upstream);
    /* Replies the relay makes itself wait here until the upstream stream is between lines. */
    const injected: string[] = [];
    const flush = (): void => {
      if (!down.atBoundary()) return;
      while (injected.length > 0 && !client.destroyed) client.write(injected.shift()!, "latin1");
    };
    const down = framer(
      (line) => {
        let out = line;
        if (mode.stripUidplus) {
          const before = out;
          if (/^\* CAPABILITY /i.test(out) || /\[CAPABILITY /i.test(out)) out = out.replace(/ UIDPLUS\b/gi, "");
          out = out.replace(/ ?\[(APPENDUID|COPYUID) [^\]]*\]/gi, "");
          if (out !== before) uidplusStripped += 1;
        }
        if (!client.destroyed) client.write(`${out}\r\n`, "latin1");
      },
      (bytes) => { if (!client.destroyed) client.write(bytes); },
    );
    const up = framer(
      (line) => {
        const tag = /^(\S+) /.exec(line)?.[1] ?? "*";
        if (mode.blindHeaderSearch && /^\S+ (UID )?SEARCH /i.test(line) && / HEADER /i.test(line)) {
          searchesBlinded += 1;
          injected.push(`* SEARCH\r\n${tag} OK SEARCH completed (relay)\r\n`);
          flush();
          return;
        }
        if (mode.refuseExpunge && /^\S+ (UID )?EXPUNGE\b/i.test(line)) {
          expungesRefused += 1;
          injected.push(`${tag} NO [CANNOT] expunge refused (relay)\r\n`);
          flush();
          return;
        }
        let out = line;
        const value = mode.rewriteHeaderValues;
        if (value !== undefined && /^\S+ (UID )?SEARCH /i.test(line)) {
          if (/ HEADER \S+ \{\d+\+?\}/i.test(line)) { literalValues += 1; client.destroy(); upstream.destroy(); return; }
          out = line.replace(/ HEADER (\S+) ("(?:[^"\\]|\\.)*"|[^\s()]+)/gi, (_m, name: string) => {
            valuesRewritten += 1;
            return ` HEADER ${name} "${value}"`;
          });
        }
        upstream.write(Buffer.from(`${out}\r\n`, "latin1"));
      },
      (bytes) => { upstream.write(bytes); },
    );
    client.on("data", (chunk: Buffer) => up.push(chunk));
    upstream.on("data", (chunk: Buffer) => { down.push(chunk); flush(); });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    get searchesBlinded() { return searchesBlinded; },
    get expungesRefused() { return expungesRefused; },
    get uidplusStripped() { return uidplusStripped; },
    get valuesRewritten() { return valuesRewritten; },
    get literalValues() { return literalValues; },
    heal(m: keyof MetaRelayOptions): void { if (m === "rewriteHeaderValues") delete mode[m]; else mode[m] = false; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

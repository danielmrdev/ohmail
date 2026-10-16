import net from "node:net";

/**
 * A TCP relay that adds a fixed one-way delay and COUNTS TAGGED IMAP COMMANDS.
 *
 * ── WHY A PROXY AND NOT A STOPWATCH ROUND THE ADAPTER ─────────────────────────────────────
 *
 * The filing path's cost is dominated by ROUND TRIPS, not by work: a `UID MOVE` of one message
 * and a `UID MOVE` of fifty cost the server about the same and the network exactly the same. On
 * a loopback container a round trip is ~0.1 ms, so a benchmark run against it measures the test
 * harness and reports that per-message filing is free — which is the opposite of what production
 * measures (0.30–0.51 s per message against real hosts). Inserting a known one-way delay makes
 * the loopback behave like a remote host and makes the two numbers comparable; counting the
 * commands makes the result reproducible independently of whatever the delay happened to be.
 *
 * `commands` counts client→server lines that begin with an imapflow tag, which is one per IMAP
 * command including the SELECTs that `getMailboxLock` issues on a mailbox switch — the ones that
 * do not appear in any adapter-level log and were half the cost of a move.
 *
 * Continuation lines (literals, `+ go ahead`) are deliberately NOT counted: they are part of the
 * command they belong to, and counting them would make a `UID MOVE` of a long UID set look
 * expensive for a reason the network does not care about.
 */
export interface LatencyProxy {
  port: number;
  commands: number;
  reset(): void;
  close(): Promise<void>;
}

/** imapflow tags look like `AAAA`, `AAAB`, … — letters, then a space, then the command. */
const TAGGED = /^[A-Za-z0-9]+ [A-Za-z]/;

export async function startLatencyProxy(
  target: { host: string; port: number }, oneWayDelayMs: number,
): Promise<LatencyProxy> {
  let commands = 0;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(target.port, target.host);
    sockets.add(upstream);
    // Line-buffered only for COUNTING; the bytes are relayed verbatim and unchunked.
    let pending = "";

    const relay = (from: net.Socket, to: net.Socket, count: boolean) => {
      from.on("data", (chunk: Buffer) => {
        if (count) {
          pending += chunk.toString("latin1");
          let nl = pending.indexOf("\r\n");
          while (nl !== -1) {
            const line = pending.slice(0, nl);
            if (TAGGED.test(line)) commands++;
            pending = pending.slice(nl + 2);
            nl = pending.indexOf("\r\n");
          }
          // A partial line longer than any plausible command means a literal payload is
          // streaming through; drop it rather than grow without bound.
          if (pending.length > 65536) pending = "";
        }
        setTimeout(() => { if (!to.destroyed) to.write(chunk); }, oneWayDelayMs);
      });
      from.on("close", () => { setTimeout(() => to.destroy(), oneWayDelayMs + 5); });
      from.on("error", () => to.destroy());
    };

    relay(client, upstream, true);
    relay(upstream, client, false);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    get commands() { return commands; },
    reset() { commands = 0; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

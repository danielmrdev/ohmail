import net from "node:net";

/**
 * A SLOW MAIL PROVIDER in front of a real IMAP server: a TCP relay that holds every chunk for
 * `delayMs` in each direction, so one command costs two delays on the wire (1100 ms each way is
 * the 2.2 s per command a slow provider was measured answering). The delay is SETTABLE, so a
 * suite can attach quickly and then turn the provider slow. The bytes are relayed verbatim.
 */
export interface SlowProvider {
  port: number;
  setDelay(ms: number): void;
  close(): Promise<void>;
}

export async function startSlowProvider(target: { host: string; port: number }): Promise<SlowProvider> {
  let delayMs = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client);
    sockets.add(upstream);
    const relay = (from: net.Socket, to: net.Socket): void => {
      from.on("data", (chunk: Buffer) => {
        const send = (): void => { if (!to.destroyed) to.write(chunk); };
        if (delayMs === 0) send(); else setTimeout(send, delayMs);
      });
      from.on("close", () => { setTimeout(() => to.destroy(), delayMs + 5); });
      from.on("error", () => to.destroy());
    };
    relay(client, upstream);
    relay(upstream, client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    setDelay(ms) { delayMs = ms; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

import net from "node:net";

/**
 * A MAIL SERVER THAT ANSWERS THE WAY DAVMAIL 7.0.0 DOES — a rewriting relay over a real GreenMail,
 * which does the IMAP work. Only DavMail's differences are applied, each read from its source
 * (`ImapConnection.java`, tag 7.0.0): its capability line and greeting, `/`, `UIDVALIDITY 1`,
 * `APPENDUID 1 <uid>`, no COPYUID, LSUB as LIST, SASL LOGIN, auto-expunge on STORE, a CREATE under
 * a missing parent answered BAD and the connection closed, `UID EXPUNGE` never answered; per arm
 * IDLE, no INTERNALDATE, or a held LOGIN. Nothing here logs: the relay carries a LOGIN.
 */
export interface DavmailLikeOptions {
  upstream: { host: string; port: number };
  /** Advertise IDLE, as DavMail does when `davmail.imapIdleDelay` is set. Default false. */
  idle?: boolean;
  /** FETCH answers without INTERNALDATE — an Exchange item with no PR 0x0E06. Default present. */
  internalDate?: "present" | "absent";
  /** DavMail 7.0.0 has no `UID EXPUNGE` branch and sends no tagged answer. Default "silent". */
  uidExpunge?: "silent" | "answered";
  /** Withhold the LOGIN reply this long (the hold), every LOGIN or the first only. */
  holdLoginMs?: number;
  holdOnce?: boolean;
  /** `davmail.imapAutoExpunge`, default true: a STORE adding `\Deleted` expunges before its OK. */
  autoExpunge?: boolean;
}

export interface DavmailLike {
  host: string;
  port: number;
  /** CREATE paths the client asked for, in DavMail spelling, in order. */
  readonly creates: readonly string[];
  /** The CREATEs answered BAD because the parent was missing; each closed its connection. */
  readonly refusedCreates: readonly string[];
  /** `UID EXPUNGE` commands that got no answer. */
  readonly uidExpungesUnanswered: number;
  /** Client connections accepted. */
  readonly connections: number;
  /** FETCH rows that carried an INTERNALDATE the relay removed. */
  readonly internalDatesRemoved: number;
  /** Plain EXPUNGE commands the CLIENT sent, by the folder selected at the time. */
  readonly plainExpunges: readonly string[];
  /** APPEND targets, in DavMail spelling: a lease renew is one APPEND to `ohmail/_meta`. */
  readonly appends: readonly string[];
  close(): Promise<void>;
}

const CAPS = (idle: boolean): string =>
  `IMAP4REV1 AUTH=LOGIN${idle ? " IDLE" : ""} MOVE SPECIAL-USE UIDPLUS`;
const LITERAL_AT_END = /\{(\d+)\+?\}$/;

/** A line splitter that passes literal payloads through untouched (see `_gmail-like.ts`). */
function lineStream(onLine: (line: string, literal: number) => void, onBytes: (b: Buffer) => void) {
  let pending = Buffer.alloc(0);
  let literal = 0;
  return (chunk: Buffer): void => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (literal > 0) {
        if (pending.length === 0) return;
        const take = Math.min(literal, pending.length);
        onBytes(pending.subarray(0, take));
        pending = pending.subarray(take);
        literal -= take;
        continue;
      }
      const nl = pending.indexOf("\r\n");
      if (nl < 0) return;
      const line = pending.subarray(0, nl).toString("latin1");
      pending = pending.subarray(nl + 2);
      const m = LITERAL_AT_END.exec(line);
      literal = m ? Number(m[1]) : 0;
      onLine(line, literal);
    }
  };
}

/** One IMAP argument at `at`: a quoted string, a literal marker, a list or an atom. */
function argAt(s: string, at: number): { text: string; end: number } | null {
  let i = at;
  while (s[i] === " ") i++;
  if (i >= s.length) return null;
  if (s[i] === "\"") {
    let j = i + 1;
    while (j < s.length && s[j] !== "\"") j += s[j] === "\\" ? 2 : 1;
    return { text: s.slice(i, j + 1), end: j + 1 };
  }
  if (s[i] === "(") {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")" && --depth === 0) break;
    }
    return { text: s.slice(i, j + 1), end: j + 1 };
  }
  let j = i;
  while (j < s.length && s[j] !== " ") j++;
  return { text: s.slice(i, j), end: j };
}

const unquote = (t: string): string =>
  t.startsWith("\"") ? t.slice(1, -1).replace(/\\(["\\])/g, "$1") : t;
const quote = (t: string): string => `"${t.replace(/(["\\])/g, "\\$1")}"`;
const toUpstream = (name: string): string => name.replace(/\//g, ".");
const toClient = (name: string): string => name.replace(/\./g, "/");

/** Rewrite the mailbox argument(s) at the given positions (0-based, after the command words). */
function rewriteArgs(rest: string, positions: readonly number[]): string {
  let out = "";
  let at = 0;
  for (let k = 0; ; k++) {
    const a = argAt(rest, at);
    if (a === null) return out + rest.slice(at);
    const lead = rest.slice(at, a.end - a.text.length);
    const text = positions.includes(k) && !a.text.startsWith("{") && !a.text.startsWith("(")
      ? quote(toUpstream(unquote(a.text))) : a.text;
    out += lead + text;
    at = a.end;
  }
}

/** Does GreenMail hold a folder at this (upstream-spelled) path? A side login, LIST, LOGOUT. */
async function folderExists(upstream: { host: string; port: number }, user: string, path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const s = net.connect(upstream.port, upstream.host);
    let buf = "";
    let step = 0;
    let found = false;
    s.setTimeout(10_000, () => { s.destroy(); reject(new Error("the side LIST did not answer")); });
    s.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      let nl: number;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (step === 0 && line.startsWith("* OK")) { step = 1; s.write(`s1 LOGIN ${quote(user)} "x"\r\n`); }
        else if (step === 1 && line.startsWith("s1 ")) { step = 2; s.write(`s2 LIST "" ${quote(path)}\r\n`); }
        else if (step === 2 && line.startsWith("* LIST ")) {
          const name = /"((?:[^"\\]|\\.)*)"\s*$/.exec(line)?.[1] ?? line.split(" ").pop() ?? "";
          if (name === path) found = true;
        } else if (step === 2 && line.startsWith("s2 ")) { step = 3; s.write("s3 LOGOUT\r\n"); resolve(found); s.end(); }
      }
    });
    s.on("error", reject);
  });
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

export async function startDavmailLike(o: DavmailLikeOptions): Promise<DavmailLike> {
  const idle = o.idle === true;
  const sockets = new Set<net.Socket>();
  const creates: string[] = [];
  const refusedCreates: string[] = [];
  let uidExpungesUnanswered = 0;
  let connections = 0;
  let internalDatesRemoved = 0;
  let loginsHeld = 0;
  const plainExpunges: string[] = [];
  const appends: string[] = [];

  const server = net.createServer((client) => {
    connections++;
    const upstream = net.connect(o.upstream.port, o.upstream.host);
    sockets.add(client); sockets.add(upstream);
    let greeted = false;
    let user = "";
    let selected = "";
    let loginTag: string | null = null;
    /* SASL LOGIN, which imapflow chooses over the LOGIN command on an AUTH=LOGIN server: DavMail
       answers it in its own branch (`ImapConnection.java` AUTHENTICATE LOGIN); GreenMail has none,
       so the relay runs the exchange and logs in upstream with what it was given. */
    let sasl: { tag: string; step: "user" | "pass"; user: string } | null = null;
    const lsubTags = new Set<string>();
    /* Auto-expunge: the client's STORE tag whose OK waits for the relay's own EXPUNGE. */
    const storeTags = new Set<string>();
    let stashed: string | null = null;
    let expunges = 0;
    /* Client lines wait here until the upstream greeting has been swallowed, and while a CREATE's
       side LIST runs: order on the wire is the order the client sent. */
    const queue: Array<() => Promise<void> | void> = [];
    let draining = false;
    const drain = async (): Promise<void> => {
      if (draining || !greeted) return;
      draining = true;
      try {
        while (queue.length > 0) await queue.shift()!();
      } finally {
        draining = false;
      }
    };
    const toUp = (s: string): void => { upstream.write(Buffer.from(s, "latin1")); };
    const toDown = (s: string): void => { client.write(Buffer.from(s, "latin1")); };
    const shut = (): void => { client.destroy(); upstream.destroy(); };
    /* DavMail's manual Office 365 sign-in blocks inside the LOGIN until its code is entered. */
    const holdLogin = async (): Promise<void> => {
      const hold = o.holdLoginMs ?? 0;
      if (hold > 0 && (!o.holdOnce || loginsHeld === 0)) {
        loginsHeld++;
        await new Promise((r) => setTimeout(r, hold));
      }
    };

    const command = (line: string): void => {
      queue.push(async () => {
        if (sasl !== null) {
          const decoded = Buffer.from(line.trim(), "base64").toString("utf8");
          if (sasl.step === "user") {
            sasl = { ...sasl, step: "pass", user: decoded };
            toDown(`+ ${Buffer.from("Password:", "utf8").toString("base64")}\r\n`);
            return;
          }
          const { tag, user: who } = sasl;
          sasl = null;
          user = who;
          loginTag = tag;
          await holdLogin();
          toUp(`${tag} LOGIN ${quote(who)} ${quote(decoded)}\r\n`);
          return;
        }
        const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
        if (!m) { toUp(`${line}\r\n`); return; }
        const [, tag, verbRaw, restRaw = ""] = m;
        const verb = verbRaw!.toUpperCase();
        const rest = restRaw;
        if (verb === "CAPABILITY") { toDown(`* CAPABILITY ${CAPS(idle)}\r\n${tag} OK CAPABILITY completed\r\n`); return; }
        if (verb === "AUTHENTICATE") {
          if ((argAt(rest, 0)?.text ?? "").toUpperCase() !== "LOGIN") {
            toDown(`${tag} NO unsupported authentication method\r\n`);
            return;
          }
          sasl = { tag: tag!, step: "user", user: "" };
          toDown(`+ ${Buffer.from("Username:").toString("base64")}\r\n`);
          return;
        }
        if (verb === "LOGIN") {
          user = unquote(argAt(rest, 0)?.text ?? "");
          loginTag = tag!;
          await holdLogin();
          toUp(`${line}\r\n`);
          return;
        }
        if (verb === "IDLE" && !idle) { toDown(`${tag} BAD command unrecognized\r\n`); return; }
        if (verb === "SELECT" || verb === "EXAMINE") selected = unquote(argAt(rest, 0)?.text ?? "");
        if (verb === "EXPUNGE") plainExpunges.push(selected);
        if (verb === "APPEND") appends.push(unquote(argAt(rest, 0)?.text ?? ""));
        if (["NAMESPACE", "ENABLE", "ID", "UNSELECT", "COMPRESS", "GETQUOTAROOT", "XLIST"].includes(verb)) {
          toDown(`${tag} BAD command unrecognized\r\n`);
          return;
        }
        const deletes = /\+FLAGS(\.SILENT)? \([^)]*\\Deleted/i.test(rest);
        if ((verb === "STORE" || (verb === "UID" && /^STORE /i.test(rest))) && deletes && o.autoExpunge !== false) {
          storeTags.add(tag!);
        }
        if (verb === "UID") {
          const sub = argAt(rest, 0);
          const subVerb = (sub?.text ?? "").toUpperCase();
          if (subVerb === "EXPUNGE" && (o.uidExpunge ?? "silent") === "silent") { uidExpungesUnanswered++; return; }
          if (subVerb === "COPY" || subVerb === "MOVE") { toUp(`${tag} UID ${rewriteArgs(rest, [2])}\r\n`); return; }
          toUp(`${line}\r\n`);
          return;
        }
        if (verb === "CREATE") {
          const name = unquote(argAt(rest, 0)?.text ?? "");
          creates.push(name);
          const cut = name.lastIndexOf("/");
          if (cut > 0) {
            const parent = name.slice(0, cut);
            if (!await folderExists(o.upstream, user, toUpstream(parent))) {
              refusedCreates.push(name);
              toDown(`${tag} BAD unable to handle request: Folder '${parent}' not found\r\n`);
              shut();
              return;
            }
          }
          toUp(`${tag} CREATE ${quote(toUpstream(name))}\r\n`);
          return;
        }
        if (verb === "LSUB") { lsubTags.add(tag!); toUp(`${tag} LIST ${rewriteArgs(rest, [1])}\r\n`); return; }
        const at: Record<string, number[]> = {
          SELECT: [0], EXAMINE: [0], DELETE: [0], SUBSCRIBE: [0], UNSUBSCRIBE: [0], STATUS: [0],
          APPEND: [0], RENAME: [0, 1], LIST: [1], COPY: [1], MOVE: [1],
        };
        const positions = at[verb];
        toUp(positions ? `${tag} ${verbRaw} ${rewriteArgs(rest, positions)}\r\n` : `${line}\r\n`);
      });
      void drain();
    };
    const fromClient = lineStream(command, (b) => { queue.push(() => { upstream.write(b); }); void drain(); });

    const answer = (line: string): string | null => {
      if (!greeted) {
        greeted = true;
        void drain();
        return `* OK [CAPABILITY ${CAPS(idle)}] IMAP4rev1 DavMail 7.0.0-4403 server ready`;
      }
      let l = line.replace(/\s*\[CAPABILITY [^\]]*\]/i, "");
      if (/^\* CAPABILITY /i.test(l)) return `* CAPABILITY ${CAPS(idle)}`;
      l = l.replace(/\[UIDVALIDITY \d+\]/i, "[UIDVALIDITY 1]")
        .replace(/\[APPENDUID \d+ (\d+)\]/i, "[APPENDUID 1 $1]")
        .replace(/\s*\[(HIGHESTMODSEQ \d+|NOMODSEQ)\]/i, "");
      if (/^\* OK \[COPYUID /i.test(l)) return null;
      const tagged = /^(\S+) (OK|NO|BAD)\b(.*)$/.exec(l);
      if (tagged && tagged[1] !== "*") {
        const [, tag, status, text] = tagged;
        if (/^davx\d+$/.test(tag!)) { const out = stashed; stashed = null; return out; }
        if (storeTags.delete(tag!) && status === "OK") {
          stashed = l;
          toUp(`davx${++expunges} EXPUNGE\r\n`);
          return null;
        }
        if (tag === loginTag) {
          loginTag = null;
          return status === "OK" ? `${tag} OK Authenticated` : `${tag} NO LOGIN failed`;
        }
        lsubTags.delete(tag!);
        if (/\[COPYUID /i.test(text!)) {
          const what = /\bCOPY\b/i.test(text!) ? "copy" : "move";
          return `${tag} ${status} ${what} completed`;
        }
        return l;
      }
      const list = /^\* (LIST|LSUB) (\([^)]*\)) (\S+) (.*)$/.exec(l);
      if (list) {
        const [, , flags, , name] = list;
        const kind = lsubTags.size > 0 ? "LSUB" : "LIST";
        return `* ${kind} ${flags} "/" ${quote(toClient(unquote(name!)))}`;
      }
      const status = /^\* STATUS (\S+|"(?:[^"\\]|\\.)*") \((.*)\)$/.exec(l);
      if (status) {
        const items = status[2]!.replace(/UIDVALIDITY \d+/i, "UIDVALIDITY 1").replace(/\s*HIGHESTMODSEQ \d+/i, "");
        return `* STATUS ${quote(toClient(unquote(status[1]!)))} (${items.trim()})`;
      }
      if (o.internalDate === "absent" && /INTERNALDATE "[^"]*"/i.test(l)) {
        internalDatesRemoved++;
        l = l.replace(/\(INTERNALDATE "[^"]*" ?/i, "(").replace(/ INTERNALDATE "[^"]*"/i, "");
      }
      return l;
    };
    const fromUpstream = lineStream(
      (line) => { const out = answer(line); if (out !== null) toDown(`${out}\r\n`); },
      (b) => { client.write(b); },
    );

    client.on("data", fromClient);
    upstream.on("data", fromUpstream);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });

  const port = await listen(server);
  return {
    host: "127.0.0.1",
    port,
    get creates() { return creates; },
    get refusedCreates() { return refusedCreates; },
    get uidExpungesUnanswered() { return uidExpungesUnanswered; },
    get connections() { return connections; },
    get internalDatesRemoved() { return internalDatesRemoved; },
    get plainExpunges() { return plainExpunges; },
    get appends() { return appends; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

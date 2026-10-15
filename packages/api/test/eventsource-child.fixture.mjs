// Run as `node --experimental-eventsource eventsource-child.fixture.mjs <url> <types json> <ms>`: Node's
// own EventSource (undici, a WHATWG implementation) listens for exactly the named types, then
// prints one JSON line of what each listener heard, plus `message` for any unnamed dispatch.
const [url, typesJson, msRaw] = process.argv.slice(2);
const types = JSON.parse(typesJson);
const heard = [];
const es = new EventSource(url);
for (const t of types) es.addEventListener(t, () => { heard.push(t); });
es.onmessage = () => { heard.push("message"); };
setTimeout(() => {
  es.close();
  process.stdout.write(`${JSON.stringify({ heard })}\n`);
  process.exit(0);
}, Number(msRaw));

import { afterAll, describe, expect, it } from "vitest";
import { closePooledDbs, makePooledDb, POOLED_IDLE_TIMEOUT_S } from "../src/client.js";

/**
 * A POOLED CONNECTION OUTLIVES A PERSON'S PAUSE BETWEEN SEARCHES. At 20 s idle the next search after
 * a pause dialled the pooler again (134-178 ms against 66-72 warm on a 10 ms round trip, measured
 * on a search rig). The handle is built without connecting.
 */
afterAll(async () => { await closePooledDbs(); });

describe("the pooled client's idle window", () => {
  it("is two minutes, read off the client the hosted API dials with", () => {
    expect(POOLED_IDLE_TIMEOUT_S).toBe(120);
    const db = makePooledDb("postgres://u:p@127.0.0.1:1/idle_timeout_probe") as unknown as { $client: { options: { idle_timeout: number } } };
    expect(db.$client.options.idle_timeout).toBe(POOLED_IDLE_TIMEOUT_S);
  });
});

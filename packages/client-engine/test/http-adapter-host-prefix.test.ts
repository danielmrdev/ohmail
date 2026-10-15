import { afterEach, describe, expect, it } from "vitest";
import { HttpAdapter } from "../src/adapters/http-adapter.js";

/**
 * THE DOUBLE-SUBMIT HEADER READS BOTH COOKIE SPELLINGS. A browser engine echoes the readable CSRF
 * cookie on every write; once the server writes `__Host-tf_csrf`, an adapter that knew only the
 * bare name would send no header and every write would be refused. The prefixed value wins when
 * both are in the jar, since only this host could have set it.
 */
const g = globalThis as unknown as { document?: { cookie: string } };
afterEach(() => { Reflect.deleteProperty(g, "document"); });

async function headerFor(cookie: string): Promise<string | null> {
  g.document = { cookie };
  let seen: string | null = null;
  const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
    seen = new Headers(init?.headers).get("x-csrf-token");
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  await new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl }).dismissHeldRelease("fp");
  return seen;
}

describe("x-csrf-token from either spelling", () => {
  it("a __Host-tf_csrf jar sends its value", async () => {
    expect(await headerFor("__Host-tf_csrf=hosted")).toBe("hosted");
  });
  it("both spellings: the prefixed one wins, in either order", async () => {
    expect(await headerFor("tf_csrf=bare; __Host-tf_csrf=hosted")).toBe("hosted");
    expect(await headerFor("__Host-tf_csrf=hosted; tf_csrf=bare")).toBe("hosted");
  });
  it("control: today's bare cookie is still sent", async () => {
    expect(await headerFor("tf_owner=x; tf_csrf=bare")).toBe("bare");
  });
});

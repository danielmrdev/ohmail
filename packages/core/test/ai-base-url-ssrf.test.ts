import { describe, it, expect } from "vitest";
import { makeAnthropicClient, DEFAULT_ANTHROPIC_BASE_URL } from "../src/index.js";
import { FIXTURE_SHAPES, anthropicKey } from "../../../test/support/fixture-credentials.js";

/**
 * the model base URL is an operator string, and this client puts the API key in
 * a header and the reader's mail in the body of every request it names. It is the one outbound
 * path carrying both, so it takes the same address gate every other outbound URL here takes, at
 * CONSTRUCTION: a deployment configured wrong fails at boot instead of shipping mail to whatever
 * origin the string happens to name.
 */

const KEY = anthropicKey("ai-base-url-ssrf");

it("the fixture key has the vendor key's shape", () => {
  expect(KEY).toMatch(FIXTURE_SHAPES.anthropic);
});

/** A fetch that fails loudly: no case below may reach the request half. */
const noRequest = (async () => {
  throw new Error("a refused base URL must never reach a request");
}) as unknown as typeof fetch;

describe("makeAnthropicClient — the base URL is judged before a request can be built", () => {
  it.each([
    ["http://169.254.169.254", "the cloud metadata service"],
    ["http://169.254.169.254/latest/meta-data/", "metadata, with a path"],
    ["http://127.0.0.1:8080", "loopback"],
    ["https://10.0.0.5", "a private range"],
    ["https://192.168.1.1/v1", "another private range"],
    ["http://[::1]/v1", "ipv6 loopback"],
    ["https://api.anthropic.com.evil.example@127.0.0.1", "userinfo hiding the real host"],
    ["https://someone:secret@gateway.example.com", "credentials in the url"],
    ["http://gateway.example.com", "plaintext — the key would cross the wire in the clear"],
    ["https://proxy.internal", "a name space that must not leave the building"],
    ["https://model.localhost", "the loopback name space"],
    ["ftp://gateway.example.com", "a scheme that is not http(s)"],
    ["gateway.example.com", "not an absolute url at all"],
  ])("refuses %s (%s)", (baseUrl) => {
    expect(() => makeAnthropicClient({ apiKey: KEY, baseUrl, fetchImpl: noRequest }))
      .toThrow(/not a permitted url/);
  });

  it("names the variable and the reason, and never the key", () => {
    const reasonOf = (baseUrl: string): string => {
      try {
        makeAnthropicClient({ apiKey: KEY, baseUrl, fetchImpl: noRequest });
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    // Each refusal says which rule refused — at boot "not permitted" alone is unactionable.
    const address = reasonOf("https://169.254.169.254");
    expect(address).toContain("ANTHROPIC_BASE_URL");
    expect(address).toContain("non-public address");
    expect(address).not.toContain(KEY);
    expect(reasonOf("http://gateway.example.com")).toContain("scheme must be https");
    expect(reasonOf("https://someone:secret@gateway.example.com")).toContain("userinfo");
  });

  // ── THE POSITIVE CONTROLS: the ordinary deployments must still construct ──────────────────
  it("admits the default, and dials it", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ content: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = makeAnthropicClient({ apiKey: KEY, fetchImpl });
    await client.messages.create({ model: "claude-haiku-4-5" });
    expect(calls).toEqual([`${DEFAULT_ANTHROPIC_BASE_URL}/v1/messages`]);
  });

  it.each([
    "https://api.anthropic.com",
    "https://api.anthropic.com/",
    "https://gateway.example.com/anthropic/v1",
    "https://gateway.example.com:8443",
  ])("admits %s", (baseUrl) => {
    expect(() => makeAnthropicClient({ apiKey: KEY, baseUrl, fetchImpl: noRequest })).not.toThrow();
  });

  it("admits a private base URL only when the self-host flag says so", () => {
    expect(() => makeAnthropicClient({ apiKey: KEY, baseUrl: "http://127.0.0.1:8080", fetchImpl: noRequest }))
      .toThrow(/not a permitted url/);
    expect(() => makeAnthropicClient({
      apiKey: KEY, baseUrl: "http://127.0.0.1:8080", allowPrivateBaseUrl: true, fetchImpl: noRequest,
    })).not.toThrow();
  });

  it("keeps the userinfo rule even under the self-host flag", () => {
    // The flag relaxes the ADDRESS rules and nothing else: a base URL carrying a password would
    // ride along on every request whatever the deployment shape is.
    expect(() => makeAnthropicClient({
      apiKey: KEY, baseUrl: "http://someone:secret@127.0.0.1:8080", allowPrivateBaseUrl: true,
      fetchImpl: noRequest,
    })).toThrow(/not a permitted url/);
  });
});

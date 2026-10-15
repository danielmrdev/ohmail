/** The window's failed pull reaches the engine log through one bounded door (FIX-022). */
import { describe, expect, it } from "vitest";
import {
  handleWindowConsentReadFailure, handleWindowSyncFailure, parseWindowConsentReadFailure, parseWindowSyncFailure,
  WINDOW_CONSENT_READ_FAILED_ROUTE, WINDOW_SYNC_FAILED_ROUTE,
} from "../src/window-report.js";

type Line = { event: string; fields: Record<string, unknown> };
function harness(authorized: boolean) {
  const lines: Line[] = [];
  const deps = {
    authorized: async () => authorized,
    log: (event: string, fields?: Record<string, unknown>) => { lines.push({ event, fields: fields ?? {} }); },
  };
  const post = (body: unknown) => new Request(`http://sidecar${WINDOW_SYNC_FAILED_ROUTE}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { lines, deps, post };
}

describe("POST /local/window/sync-failed", () => {
  it("answers 204 and writes one window_sync_failed line carrying exactly the census fields", async () => {
    const { lines, deps, post } = harness(true);
    const res = await handleWindowSyncFailure(post({ attempt: 7, reason: "window_fault", errorClass: "RangeError" }), deps);
    expect(res.status).toBe(204);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.event).toBe("window_sync_failed");
    // A LITERAL field set: status and code are on every line, `null` when the door answered none,
    // so the log census can read the keys and a reader never has to guess which shape a line has.
    expect(lines[0]!.fields).toEqual({
      route: WINDOW_SYNC_FAILED_ROUTE, count: 7, reason: "window_fault", errorClass: "RangeError", status: null, code: null,
    });
  });
  it("carries status and code when the door answered one", async () => {
    const { lines, deps, post } = harness(true);
    await handleWindowSyncFailure(post({ attempt: 1, reason: "http_refusal", errorClass: "MutationRejectedError", status: 410, code: "cursor_expired" }), deps);
    expect(lines[0]!.fields).toMatchObject({ status: 410, code: "cursor_expired" });
  });
  it("refuses without the launch bearer, and logs nothing", async () => {
    const { lines, deps, post } = harness(false);
    const res = await handleWindowSyncFailure(post({ attempt: 1, reason: "unknown", errorClass: "Error" }), deps);
    expect(res.status).toBe(401);
    expect(lines).toHaveLength(0);
  });
  it("a body carrying free text is refused whole and none of the text reaches the log", async () => {
    const { lines, deps, post } = harness(true);
    const leak = "Subject: the merger, from owner@example.test";
    const res = await handleWindowSyncFailure(post({ attempt: 1, reason: "unknown", errorClass: "Error", message: leak }), deps);
    expect(res.status).toBe(400);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.event).toBe("window_sync_report_refused");
    expect(JSON.stringify(lines)).not.toContain("merger");
    expect(JSON.stringify(lines)).not.toContain("owner@");
  });
  it("the parser bounds every field", () => {
    expect(parseWindowSyncFailure({ attempt: 0, reason: "unknown", errorClass: "Error" })).toEqual({ refused: "attempt is not a bounded count" });
    expect(parseWindowSyncFailure({ attempt: 1, reason: "Has Spaces", errorClass: "Error" })).toEqual({ refused: "reason is not a token" });
    expect(parseWindowSyncFailure({ attempt: 1, reason: "unknown", errorClass: "a subject line here" })).toEqual({ refused: "errorClass is not a class name" });
    expect(parseWindowSyncFailure({ attempt: 1, reason: "unknown", errorClass: "Error", status: 42 })).toEqual({ refused: "status is not an HTTP status" });
    expect(parseWindowSyncFailure({ attempt: 1, reason: "unknown", errorClass: "Error", code: "Not_A_Code" })).toEqual({ refused: "code is not a token" });
    expect(parseWindowSyncFailure([])).toEqual({ refused: "not an object" });
    expect(parseWindowSyncFailure("not json object")).toEqual({ refused: "not an object" });
  });
  it("a body over the bound and a non-JSON body are refused by name", async () => {
    const { lines, deps, post } = harness(true);
    expect((await handleWindowSyncFailure(post("x".repeat(2000)), deps)).status).toBe(400);
    expect((await handleWindowSyncFailure(post("{not json"), deps)).status).toBe(400);
    expect(lines.map((l) => l.fields.reason)).toEqual(["body over the bound", "not JSON"]);
  });
});

describe("POST /local/window/consent-read-failed (FIX-025)", () => {
  const post = (body: unknown) => new Request(`http://sidecar${WINDOW_CONSENT_READ_FAILED_ROUTE}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  it("answers 204 and writes one consent_read_failed line: the status, or the class, never a body", async () => {
    const { lines, deps } = harness(true);
    expect((await handleWindowConsentReadFailure(post({ attempt: 1, reason: "refused", status: 503 }), deps)).status).toBe(204);
    await handleWindowConsentReadFailure(post({ attempt: 2, reason: "shape" }), deps);
    await handleWindowConsentReadFailure(post({ attempt: 3, reason: "unreachable", errorClass: "BridgeDeadlineError" }), deps);
    expect(lines.map((l) => l.event)).toEqual(["consent_read_failed", "consent_read_failed", "consent_read_failed"]);
    expect(lines.map((l) => l.fields)).toEqual([
      { route: WINDOW_CONSENT_READ_FAILED_ROUTE, count: 1, reason: "refused", status: 503, errorClass: null },
      { route: WINDOW_CONSENT_READ_FAILED_ROUTE, count: 2, reason: "shape", status: null, errorClass: null },
      { route: WINDOW_CONSENT_READ_FAILED_ROUTE, count: 3, reason: "unreachable", status: null, errorClass: "BridgeDeadlineError" },
    ]);
  });
  it("refuses without the launch bearer, and logs nothing", async () => {
    const { lines, deps } = harness(false);
    expect((await handleWindowConsentReadFailure(post({ attempt: 1, reason: "shape" }), deps)).status).toBe(401);
    expect(lines).toHaveLength(0);
  });
  it("a body carrying anything else is refused whole and none of it reaches the log", async () => {
    const { lines, deps } = harness(true);
    const res = await handleWindowConsentReadFailure(post({ attempt: 1, reason: "shape", body: "{\"dormancy\":\"owner@example.test\"}" }), deps);
    expect(res.status).toBe(400);
    expect(lines.map((l) => l.event)).toEqual(["window_consent_report_refused"]);
    expect(JSON.stringify(lines)).not.toContain("owner@");
    expect((await handleWindowConsentReadFailure(post("not json"), deps)).status).toBe(400);
  });
  it("the parser bounds every field and admits the three shapes the window sends", () => {
    expect(parseWindowConsentReadFailure({ attempt: 1, reason: "refused", status: 503 })).toEqual({ attempt: 1, reason: "refused", status: 503 });
    expect(parseWindowConsentReadFailure({ attempt: 0, reason: "shape" })).toEqual({ refused: "attempt is not a bounded count" });
    expect(parseWindowConsentReadFailure({ attempt: 1, reason: "window_fault" })).toEqual({ refused: "reason is not a known token" });
    expect(parseWindowConsentReadFailure({ attempt: 1, reason: "refused", status: 42 })).toEqual({ refused: "status is not an HTTP status" });
    expect(parseWindowConsentReadFailure({ attempt: 1, reason: "unreachable", errorClass: "a sentence" })).toEqual({ refused: "errorClass is not a class name" });
    expect(parseWindowConsentReadFailure(null)).toEqual({ refused: "not an object" });
  });
});

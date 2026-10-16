/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";

import en from "../../webapp/messages/en.json";
import { useDraftReply, type DraftedReply } from "../../webapp/app/shell/draft-reply.js";
import type { DraftReplyTransport } from "../../webapp/app/shell/draft-reply.js";
import { aiRefusalKey } from "../../webapp/app/shell/ai-refusal-copy.js";
import { desktopDraftReplyTransport } from "../src/local-draft-reply.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const MESSAGE_ID = "synthetic-message-1";
const DRAFT_ID = "synthetic-draft-1";

interface RequestRecord { method: string; url: string; headers: Array<[string, string]>; body: string }
interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback?: unknown;
  };
}
const host = globalThis as unknown as Host;

function encode(status: number, body: unknown): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

let root: Root | null = null;
let mount: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  mount?.remove();
  root = null;
  mount = null;
  delete host.__TAURI_INTERNALS__;
});

function Harness({
  transport,
  onDraft,
}: {
  transport: DraftReplyTransport;
  onDraft: (draft: DraftedReply, messageId: string) => void;
}) {
  const control = useDraftReply({ transport, onDraft });
  return h("section", null,
    h("button", { onClick: () => control.open(MESSAGE_ID) }, "Offer"),
    h("button", { onClick: control.confirm }, "Confirm"),
    h("p", { role: "status" }, control.notice ?? ""),
  );
}

describe("desktop AI reply drafting", () => {
  it("uses the engine bridge and places the stored draft instead of claiming Cloud account is required", async () => {
    const requests: RequestRecord[] = [];
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, payload) => {
        if (command !== "engine_request") throw new Error(`unexpected shell command: ${command}`);
        const method = String(payload?.method ?? "GET");
        const url = String(payload?.url ?? "");
        const headers = (payload?.headers as Array<[string, string]> | undefined) ?? [];
        const bytes = Uint8Array.from((payload?.body as number[] | undefined) ?? []);
        requests.push({ method, url, headers, body: new TextDecoder().decode(bytes) });
        if (method === "POST" && url === `/messages/${MESSAGE_ID}/draft`) {
          return encode(202, { draftId: DRAFT_ID });
        }
        if (method === "GET" && url === `/drafts/${DRAFT_ID}`) {
          return encode(200, { body: "Synthetic drafted reply", html: null });
        }
        return encode(404, { error: { code: "not_found", message: "not found" } });
      },
    };

    const drafts: Array<{ draft: DraftedReply; messageId: string }> = [];
    mount = document.createElement("div");
    document.body.appendChild(mount);
    root = createRoot(mount);
    await act(async () => {
      root!.render(h(IntlProvider, {
        locale: "en", messages: en as never, timeZone: "UTC",
        children: h(Harness, {
          transport: desktopDraftReplyTransport,
          onDraft: (draft, messageId) => drafts.push({ draft, messageId }),
        }),
      }));
    });
    await act(async () => { mount!.querySelectorAll("button")[0]!.click(); });
    await act(async () => {
      mount!.querySelectorAll("button")[1]!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mount.textContent).not.toContain(en.draftReply.unavailable);
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST /messages/${MESSAGE_ID}/draft`,
      `GET /drafts/${DRAFT_ID}`,
    ]);
    expect(requests[0]?.headers.some(([name, value]) => name.toLowerCase() === "idempotency-key" && value.length > 0)).toBe(true);
    expect(drafts).toEqual([{
      draft: { text: "Synthetic drafted reply", html: "" },
      messageId: MESSAGE_ID,
    }]);
    expect(mount.textContent).not.toContain(en.draftReply.unavailable);
  });

  it("uses localized no-model copy for the engine's missing-drafter refusal", () => {
    expect(aiRefusalKey(Object.assign(new Error("no configured drafter"), { code: "drafter_unconfigured" })))
      .toBe("noModel");
    expect(en.aiRefusal.noModel).toContain("draft");
  });
});

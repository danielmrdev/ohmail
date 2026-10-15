/**
 * WHAT ONE SEND FROM THIS WINDOW CAN CARRY, per door. Every send's attachments cross the bridge
 * as base64 inside the queued change the window records (`window-outbox.ts`, 31 MiB per write,
 * under the shell's 32 MiB frame) before anything leaves this computer, so 22 MiB of files is
 * this window's ceiling on every door, whatever the mail server would take. The hosted door
 * also stages its bytes to storage (`stagesAttachments`), so its ceiling is the smaller of this
 * and the hosted staging bound; the self-hosted and paired doors declare nothing and keep the
 * strict inline constant.
 */
import { COMPOSE_ATTACH_STAGED_SURFACE_BYTES } from "@ohmail/client-engine";
import type { EngineStatus } from "./bridge-fetch.js";
import { flavorOf } from "./doors.js";

/** Raw attachment bytes one send from this window carries — base64 plus the message fit one write. */
export const DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES = 22 * 1024 * 1024;

/** The hosted door, and only it, stages attachment bytes to the account's storage. */
export function stagesAttachments(status: EngineStatus | null): boolean {
  return flavorOf(status) === "managed";
}

/**
 * The compose surface this door declares: a number, or `undefined` for a door that keeps the
 * strict inline constant. Never `null`: no door of this window is uncapped.
 */
export function desktopSendSurface(status: EngineStatus | null): number | undefined {
  if (status?.mode === "local") return DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES;
  if (stagesAttachments(status)) {
    return Math.min(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES, COMPOSE_ATTACH_STAGED_SURFACE_BYTES);
  }
  return undefined;
}

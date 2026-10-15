/**
 * Types for the shared rig corpus. The module itself is `.mjs` because the Node rig loads it
 * without a build step and the browser rig bundles it; the browser rig is TYPECHECKED (it lives
 * under `apps/desktop/test`, which the ratchet reaches), so without this it imports `any` and
 * raises that directory's pin.
 */

export interface RigMessage {
  id: string;
  accountId: string;
  mailboxId: string;
  threadId: string | null;
  messageIdHeader: string | null;
  subject: string;
  from: { name: string | null; address: string };
  to: Array<{ name: string | null; address: string }>;
  cc: Array<{ name: string | null; address: string }>;
  date: string;
  folder: string;
  snippet: string;
  unread: boolean;
  hasAttachments: boolean;
  attachmentCount: number;
  sensitivity: {
    sensitive: boolean; category: string | null; no_ai: boolean;
    no_forward: boolean; no_kb: boolean; priority: boolean;
  };
  triage: string | null;
  labels: string[];
  remoteContent: string;
  updatedAt: string;
}

export declare const CORPUS_NOW: Date;
export declare const CORPUS_OWNER: string;
export declare const FOLDERS: ReadonlyArray<{ name: string; count: number; dayOff: number }>;
export declare function corpus(opts?: {
  scale?: number;
  order?: "asc" | "desc";
  now?: Date;
}): RigMessage[];
export declare function corpusFingerprint(messages: ReadonlyArray<RigMessage>): string;

/**
 * THE FOUR OPEN-READ SHAPES, as data — one table for the engine's overlay, the fixture echo and the
 * server's two runs (`packages/services/test/mark-seen-open-read{,.pg}.test.ts`), so the three answers
 * are compared over the same rows. `thread` names a conversation; `held` is the row the reader has
 * open; `serverFlag` is what the server's own guard is handed (the third shape's body carries the flag a broken
 * client would send, and the server still stamps nothing). `stamped`/`cleared` are the labels whose
 * `openReadAt` becomes an instant / null. Pure data: no imports, nothing to resolve across packages.
 */
export interface OpenReadRow { label: string; thread: string; arrived: string; unread: boolean; openReadAt?: string }
export interface OpenReadShape {
  name: string;
  rows: OpenReadRow[];
  held: string;
  ids: string[];
  unread: boolean;
  serverFlag: boolean;
  stamped: string[];
  cleared: string[];
}

export const OPEN_READ_SHAPES: readonly OpenReadShape[] = [
  {
    name: "the glance: the open message alone",
    rows: [{ label: "f", thread: "F", arrived: "2026-07-24T00:15:00.000Z", unread: true }],
    held: "f", ids: ["f"], unread: false, serverFlag: true, stamped: ["f"], cleared: [],
  },
  {
    name: "the press: two of three members of the held conversation unread",
    rows: [
      { label: "a1", thread: "A", arrived: "2026-07-23T09:00:00.000Z", unread: true },
      { label: "a2", thread: "A", arrived: "2026-07-23T10:00:00.000Z", unread: true },
      { label: "a3", thread: "A", arrived: "2026-07-23T11:00:00.000Z", unread: false },
    ],
    held: "a2", ids: ["a1", "a2", "a3"], unread: false, serverFlag: true, stamped: ["a1", "a2"], cleared: [],
  },
  {
    name: "two conversations: read, never placed",
    rows: [
      { label: "a1", thread: "A", arrived: "2026-07-23T09:00:00.000Z", unread: true },
      { label: "b1", thread: "B", arrived: "2026-07-23T10:00:00.000Z", unread: true },
    ],
    held: "a1", ids: ["a1", "b1"], unread: false, serverFlag: true, stamped: [], cleared: [],
  },
  {
    name: "marked unread: the stamp clears",
    rows: [{
      label: "a1", thread: "A", arrived: "2026-07-23T09:00:00.000Z", unread: false,
      openReadAt: "2026-07-28T09:00:00.000Z",
    }],
    held: "a1", ids: ["a1"], unread: true, serverFlag: false, stamped: [], cleared: ["a1"],
  },
];

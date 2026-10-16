/** Declarations for `comment-blocks.mjs`, so the census that reads it can be typechecked. */
export interface Block { start: number; end: number; lines: number; digest: string }
export function commentBlocks(text: string, fileName: string, ts: unknown): Block[];
export const MAX_COMMENT_LINES: number;
/* The root lists and the predicate the tip census and the range gate share. A declaration that
   lags the module is the census importing a member TypeScript cannot see: three TS2305 errors in
   an unreached test dir, which only the ratchet reads. Every export here, or none. */
export const SWEPT_ROOTS: string[];
export const SCRIPT_ROOTS: string[];
export const SCRIPT_EXCLUDE: string[];
export const TEST_ROOTS: string[];
export function coversPath(rel: string): boolean;
export function isTestPath(rel: string): boolean;
export function coversSource(rel: string): boolean;
export function blockDigest(lines: readonly string[]): string;
export const RE_HOME_WITHIN: number;
export interface PinAdvice {
  verdict: "ok" | "re-home" | "drop" | "ambiguous";
  by: "line" | "content" | "distance";
  why: (key: string, rel: string) => string;
}
export function pinAdvice(
  over: readonly Block[], at: number, claimed: ReadonlySet<number>, was?: string,
): PinAdvice;

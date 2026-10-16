import type { ApiDeps } from "../../src/deps.js";
import type { StaffContext, StaffRead } from "../../src/routes/admin.js";
import type { RouteParams } from "../../src/router.js";

/**
 * THE STAFF CALLBACK CONTRACT, PINNED WHERE THE COMPILER CAN SEE IT.
 *
 * This file contains no runtime code and no test. It is a set of assertions that only exist as
 * types, and the thing that runs them is `tsc`: the package's contract tsconfig is a
 * project that compiles this directory and nothing else, it is referenced from the root
 * `tsconfig.json` so `pnpm typecheck` builds it, and the staff contract test
 * invokes the same build so the suite reports it under a name too.
 *
 * ── WHY THE PIN IS A `keyof` AND NOT A COMMENT ─────────────────────────────────────────────
 *
 * A review finding was "every admin handler receives the unrestricted runtime handle, so a seventh
 * endpoint can bypass `AdminDb` and compile", and its stated forge was `as unknown as AdminDb`.
 * The fix is NOT a better brand — a brand is erased at runtime and a cast needs something
 * runtime-capable to cast FROM. The fix is that `ApiDeps` never enters the callback, so there
 * is no `Db` value to forge from, capture in a closure, launder through a helper, or default a
 * parameter to. That property is exactly "the context has these five fields and no sixth", so
 * that is what is pinned: widening {@link StaffContext} by one field is a compile error until
 * somebody edits this list on purpose.
 *
 * What these assertions do NOT prove, and no type can: nothing stops a callback importing a
 * pool factory and reading a connection URL out of the environment itself. That is the
 * malicious-insider path, not the forgotten-endpoint path the "Account isolation is absolute, and it binds staff too" invariant targets; the source scan in
 * `staff-contract.test.ts` is the cheap corroboration against it, and the honest statement of
 * the residue is in `routes/admin.ts` §3 and the project's design notes.
 */

/** Invariant type equality — distinguishes `any`, and does not accept a mere subtype. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

/**
 * ONE — the context's shape, exactly. A sixth field fails here; so does deleting one.
 */
export type StaffContextKeysArePinned = Expect<
  Equal<keyof StaffContext, "db" | "now" | "environment" | "logger" | "apiHealth">
>;

/**
 * TWO — the mechanism behind the rejection below, named on its own so a diff can see it: the
 * staff context is NOT an `ApiDeps`, which is what makes a callback that asks for one refuse to
 * take the context it will actually be handed.
 */
export type StaffContextIsNotApiDeps = Expect<
  Equal<StaffContext extends ApiDeps ? "assignable" : "rejected", "rejected">
>;

/**
 * THREE — the seventh endpoint, written out. A callback that declares `ApiDeps` in the context
 * slot must not be a {@link StaffRead}.
 *
 * Stated twice on purpose. `@ts-expect-error` is satisfied by ANY error on the next line, so on
 * its own it can be kept green by a typo; the `Equal<…, "rejected">` above it cannot. If the
 * contract is widened back, the directive becomes "Unused '@ts-expect-error' directive" (TS2578)
 * and the assignability assertion fails at the same time.
 */
export type ApiDepsCallbackIsRejected = Expect<
  Equal<
    ((req: Request, deps: ApiDeps, params: RouteParams) => Promise<unknown>) extends StaffRead
      ? "assignable"
      : "rejected",
    "rejected"
  >
>;

// @ts-expect-error — a staff read may not name `ApiDeps`; there is no runtime handle to hand it.
export const seventhEndpoint: StaffRead = async (
  _req: Request, deps: ApiDeps, _params: RouteParams,
): Promise<unknown> => deps.db;

/**
 * FOUR — the shape a real read is written against still compiles. Without this the three
 * refusals above could be satisfied by a contract nothing can use.
 */
export const permittedRead: StaffRead = async (
  _req: Request, ctx: StaffContext, _params: RouteParams,
): Promise<unknown> => ({
  db: typeof ctx.db,
  at: ctx.now().toISOString(),
  environment: ctx.environment,
  health: await ctx.apiHealth(),
});

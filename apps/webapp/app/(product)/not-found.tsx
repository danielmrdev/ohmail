import { DEFAULT_LOCALE } from "../shell/locale";
import { NotFoundPage } from "./NotFoundPage";

/**
 * The 404 boundary every build carries. The `[...missing]` catch-all beside it calls `notFound()`
 * for every path no route claims, and this renders the branded page with a real 404 status. It
 * sits in `(product)` because the app has no shared root layout (a top-level `app/not-found.tsx`
 * fails `next build`) and this is the group a self-hosted build always ships. English, like the
 * catch-all's title: the path is unknown, so nothing says which language was wanted.
 */
export default function NotFound() {
  return <NotFoundPage locale={DEFAULT_LOCALE} />;
}

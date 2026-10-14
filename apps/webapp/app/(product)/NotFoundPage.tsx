import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { AppLocale } from "../shell/locale";
import { DotLabel, Wordmark } from "./Wordmark";
import "./not-found.css";

/**
 * The page a mistyped address lands on, in one locale. It lives in `(product)` because that group
 * ships with every build: `(product)/not-found.tsx` serves the catch-all, and the website's two root
 * layouts mount the same composition for their own `notFound()` (a boundary only catches what is
 * raised inside its own root layout). Deliberately no `Nav` and no `Footer`. The way back goes to
 * `/`, which re-decides for the visitor on every deployment.
 */
export async function NotFoundPage({ locale }: { locale: AppLocale }) {
  /* The locale is PASSED, never resolved: this renders inside a root layout that pinned one as
     a literal, and an implicit lookup would fall through to the request config's `headers()`
     read, which the website's static pages must not make. */
  const t = await getTranslations({ locale, namespace: "notFound" });
  return (
    <main className="nf">
      <Link href="/" className="nf-brand">
        <Wordmark />
      </Link>
      <p className="nf-code" aria-hidden="true">
        404
      </p>
      <h1 className="nf-title">{t("title")}</h1>
      <p className="nf-note">{t("note")}</p>
      <Link href="/" className="btn primary nf-home">
        <DotLabel text={t("home")} />
      </Link>
    </main>
  );
}

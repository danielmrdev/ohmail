import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DEFAULT_LOCALE } from "../../shell/locale";

/**
 * The catch-all that makes a branded 404 possible at all. The app has more than one root layout and
 * Next only renders a root `app/not-found.tsx` inside a root layout the app deliberately does not
 * have, so unknown paths would fall through to the framework's unbranded 404. This segment matches
 * every path no real route claims (a catch-all always loses to a more specific route) and does one
 * thing: `notFound()`, which renders the sibling `not-found.tsx` WITH a real 404 status, since a
 * branded page served 200 teaches every crawler that garbage paths exist.
 */

export async function generateMetadata(): Promise<Metadata> {
  /* The locale is passed rather than resolved: `getTranslations()` with no locale reads the
     request config, which since the bilingual slice resolves `requestLocale` — and on a route
     no layout has pinned that means a `headers()` read. This catch-all is English by design
     (its sibling `not-found.tsx` renders the English page), so it says so. */
  const t = await getTranslations({ locale: DEFAULT_LOCALE, namespace: "notFound" });
  return { title: `${t("title")} · ohmail`, robots: { index: false, follow: false } };
}

export default function MissingPage(): never {
  notFound();
}

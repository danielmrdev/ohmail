// The harness's `next-intl`: use-intl, which next-intl IS on the client (see build-harness.mjs).
// A `.mjs` on purpose — the webapp's tsconfig sweeps `test/**`, and `use-intl` is not one of its
// dependencies, so the shim stays outside the typecheck while the harness itself imports
// `next-intl` exactly as the shell does.
export * from "use-intl";
export { IntlProvider as NextIntlClientProvider } from "use-intl";

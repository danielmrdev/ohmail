# CLAUDE.md

Notes for coding assistants working in this repository. People: read [CONTRIBUTING.md](CONTRIBUTING.md)
first — everything here is said there or in the README, in the form an assistant reads.

## What this repository is

ohmail, an email client, under AGPL-3.0 ([LICENSE](LICENSE), [COPYRIGHT](COPYRIGHT)). The desktop app is
`apps/desktop` (Tauri: the Rust shell in `src-tauri`, the window in `src`). The server, the worker, the web app,
the phone app and the shared packages live in `apps/` and `packages/`; self-hosting and packaging recipes in
`deploy/`.

## Setting it up

The root is an npm workspace with one committed lockfile:

```bash
npm ci
```

`apps/desktop` carries its own lockfile and is installed and checked on its own:

```bash
cd apps/desktop
npm ci
npm run ui:typecheck      # tsc over the shell, the views and the shim
npm run ui:build:engine   # the bundle the app embeds, into dist/
npm run smoke             # renders the built bundle and audits it offline
```

The toolchain is Node 22 and stable Rust; "Build the desktop app yourself" in the README has the platform
packages and the whole build.

## Tests and CI

The workflows are in `.github/workflows/`. `build.yml` runs on pull requests and on `main`: on macOS, Windows and
Linux it typechecks the window, builds the UI bundle and smokes it, runs the Rust tests in both configurations,
packages the app and opens what it built; its engine job bundles the engine on its own. `android.yml` builds the
phone app, and `dco.yml` checks sign-offs. Tests sit beside the code they cover: `apps/desktop/test`, and the
`*_tests.rs` files in `apps/desktop/src-tauri/src`. Add or extend a test for behaviour you change.

## Rules the suite enforces

- Colours and shadows come from `packages/tokens`, never hand-written in a view.
- No message is ever replaced by a "N more" placeholder.

## Contributing

- Match the surrounding style; there is no formatter config to fight with.
- Open an issue before a large change, and before any IMAP or sync change: that layer has a design that is not
  published yet.
- Sign every commit (Developer Certificate of Origin, no CLA): `git commit -s`. The dco check asks each commit
  for a sign-off whose address is its author's or its committer's.
- Security reports go the way [SECURITY.md](SECURITY.md) describes, never into an issue.

# Project Context

This repository is the public mirror of Ohmail: a Tauri desktop mail client and self-hosted service source.

## Tooling

- Use Node 22 and npm. The root lockfile covers shared workspaces and the mail engine; `apps/desktop` has its own lockfile and dependencies.
- For the full desktop build sequence, follow [README.md](README.md#build-the-desktop-app-yourself); Tauri-specific build and verification details live in [apps/desktop/README.md](apps/desktop/README.md).
- Install desktop dependencies with `npm ci` from `apps/desktop`; build the engine-bearing desktop app with `npm run app:build:engine` from that directory.
- Before an AppImage build, pin Tauri's GTK hook: `install -m 755 apps/desktop/src-tauri/linux/linuxdeploy-plugin-gtk.sh ~/.cache/tauri/linuxdeploy-plugin-gtk.sh`. The cached upstream hook forces `GDK_BACKEND=x11`, making HiDPI Wayland render through XWayland at 1×.
- On Arch, build from `apps/desktop` with `NO_STRIP=1 mise exec node@22.23.1 -- npm run app:build:engine -- --bundles appimage`; Tauri's bundled `linuxdeploy` strip rejects host `.relr.dyn`.

## Upstream PRs

- Keep fork-only files and changes on `origin/main`. Start every PR for `trafficflowhq/ohmail` from `upstream/main`, never from `main` or `origin/main`; prefer a separate worktree.
- Commit only PR-scoped changes. When reusing work from another branch, cherry-pick only clean feature commits; split mixed commits first.
- Before pushing, inspect `git log --oneline upstream/main..HEAD` and `git diff --name-status upstream/main...HEAD`. Check both commit history and final file changes for fork-only content, unrelated local docs/research, or other out-of-scope changes.
- Before opening a follow-up issue, search upstream issues, PRs, and branch history; link an existing report or fix instead of filing a duplicate.
- For shared Cloud paths, read the shared-path and licensing guidance in `CONTRIBUTING.md`; state which surfaces change and test the intended Cloud/desktop boundary. For behavior or timing changes, test adjacent paths and keep the change scoped to the path that needs it.
- Keep test evidence baseline-aware: compare unexplained failures with the same tests on `upstream/main`, separate pre-existing failures from regressions, and report remaining red checks honestly.
- If a maintainer carries work into a replacement PR, follow it to merge and confirm your authorship and sign-off/co-author attribution survive.
- Push the feature branch to `origin` and target the PR at `trafficflowhq/ohmail:main`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `danielmrdev/ohmail`; use `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use single-context layout: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.

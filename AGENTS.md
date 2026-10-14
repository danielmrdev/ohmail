# Project Context

This repository is the public mirror of Ohmail: a Tauri desktop mail client and self-hosted service source.

## Tooling

- Use Node 22 and npm. The root lockfile covers shared workspaces and the mail engine; `apps/desktop` has its own lockfile and dependencies.
- For the full desktop build sequence, follow [README.md](README.md#build-the-desktop-app-yourself); Tauri-specific build and verification details live in [apps/desktop/README.md](apps/desktop/README.md).
- Install desktop dependencies with `npm ci` from `apps/desktop`; build the engine-bearing desktop app with `npm run app:build:engine` from that directory.
- Before an AppImage build, pin Tauri's GTK hook: `install -m 755 apps/desktop/src-tauri/linux/linuxdeploy-plugin-gtk.sh ~/.cache/tauri/linuxdeploy-plugin-gtk.sh`. The cached upstream hook forces `GDK_BACKEND=x11`, making HiDPI Wayland render through XWayland at 1×.
- On Arch, build from `apps/desktop` with `NO_STRIP=1 mise exec node@22.23.1 -- npm run app:build:engine -- --bundles appimage`; Tauri's bundled `linuxdeploy` strip rejects host `.relr.dyn`.

# ohmail for Omarchy

An Omarchy shell plugin: unread mail in the bar, one key to summon ohmail, and
two small commands for the desktop plumbing around it.

`omarchy plugin add` clones a git repository and reads `manifest.json` at its
root, so the plugin goes in from a small repository of its own, made from this
directory. It lives in `~/.local/share/ohmail/omarchy-plugin`, which is also
where `omarchy plugin update` fetches from:

```bash
plugin=~/.local/share/ohmail/omarchy-plugin
src=$(mktemp -d) &&
git clone -q --depth 1 https://github.com/trafficflowhq/ohmail.git "$src" &&
mkdir -p "$plugin" && git -C "$plugin" init -q &&
git -C "$plugin" rm -rq --ignore-unmatch . &&
cp -a "$src/deploy/omarchy-plugin/." "$plugin" &&
git -C "$plugin" add -A &&
{ git -C "$plugin" diff --cached --quiet ||
  git -C "$plugin" -c user.name=ohmail -c user.email=ohmail@localhost commit -q -m "ohmail for Omarchy"; } &&
rm -rf "$src" &&
omarchy plugin add "$plugin" --enable --yes
```

To update, run the same lines with `omarchy plugin update ohmail.mail --yes` as
the last one. A step that fails stops the rest, so a failed clone commits
nothing.

Needs [ohmail](https://github.com/trafficflowhq/ohmail) itself — on Arch,
`yay -S ohmail-bin`.

## What it does

**The bar widget** draws an envelope, and a number beside it when it has one.
Press it to summon ohmail; right-press to refresh.

**`bin/ohmail-summon`** focuses the ohmail window if it is open and starts it if
it is not. This is what the keybind runs.

**`bin/ohmail-keybind install`** binds `SUPER + M` to that, by appending one
line to `~/.config/hypr/bindings.lua`. `print` shows you the line instead if you
would rather place it yourself, and `remove` takes it back out. `SUPER + M` was
free on a stock Omarchy 4 install — checked against `hyprctl binds`.

**`bin/ohmail-mailto set`** makes ohmail the app that opens `mailto:` links.
`status` says what currently does; `unset` hands it back. This is a command
rather than something installing the plugin does for you, because which mail
client opens your links is your call. ohmail's own desktop entry already
declares the scheme, so there is nothing to register — only a default to point.

## The unread count: what it can and cannot know

**The widget draws a number it is told. It never invents one, and it never shows
a zero it cannot stand behind** — when it has no source it draws a dimmed
envelope with no number and says why on hover. A "0" and an "I don't know" must
not look the same in a status bar.

That caveat is not modesty, it is the actual situation, and it is worth being
precise about:

- **The ohmail desktop app cannot be asked.** Its mail engine is a child process
  that speaks length-prefixed frames over its own stdin and stdout. There is no
  socket and no port — by design, so that nothing but the app itself can talk to
  your mailbox. (Turning on same-network access opens a loopback HTTP door for
  your own paired devices, but it is off by default and wants a paired device's
  credentials, which is not something a bar widget should hold.)
- **The ohmail Cloud API has no unread-count endpoint.** The message list is
  cursor-paged with no total and search needs a query, so counting would mean
  walking your whole mailbox on a timer while keeping a rotating refresh token
  in a config file. That is a bad trade for a number in a bar.

So the count comes from one of these, and you pick:

| Source | How | Works today |
| --- | --- | --- |
| A push over IPC | `omarchy-shell ohmail.mail setUnread 7` | Yes — anything that knows can push |
| A command you supply | the widget's `command` setting, or `$OHMAIL_UNREAD_COMMAND` | Yes |
| A count file | a plain integer in `$XDG_RUNTIME_DIR/ohmail/unread` | The file is read; **nothing writes it yet** |
| Nothing | — | Dimmed envelope, no number |

The count file is the seam meant for the app: it already knows the number and
writing one line is cheap. As of ohmail 0.13.1 it does not write it, and this
plugin does not pretend otherwise — that source simply never fires until it
does.

`bin/ohmail-unread` is the whole of this logic and it runs fine by hand:

```bash
./bin/ohmail-unread                        # {"state":"unknown","why":"no count source — …"}
./bin/ohmail-unread --demo 7               # {"state":"ok","unread":7,"why":"demo fixture"}
OHMAIL_UNREAD_COMMAND='echo 12' ./bin/ohmail-unread
```

`./selftest` asserts all of it — that `010` is ten and not octal eight, that a
command printing `1 2` yields no number at all rather than twelve, and that the
output is parseable JSON even when the answer is "I don't know". Both of those
first two were bugs before they were tests.

## Notifications

There is nothing here for notifications, on purpose. ohmail posts its
notifications through the ordinary freedesktop notification service, and
Omarchy's own `omarchy.notifications` plugin is what serves that — so they arrive
already styled like the rest of your desktop. Checked rather than assumed: a
notification posted on the session bus of a stock Omarchy 4 install renders in
the same stack, in the same style, as Omarchy's own.

A second implementation in here would duplicate a working path and be one more
thing to keep in step.

## Settings

Bar widget settings are inline on the entry in `~/.config/omarchy/shell.json`:

```json
{ "id": "ohmail.mail", "intervalMs": 60000, "command": "" }
```

| Key | Default | What it is |
| --- | --- | --- |
| `intervalMs` | `60000` | How often to poll the count source. Floored at 5000. |
| `command` | `""` | A command that prints the unread count as a plain integer. |

## IPC

```bash
omarchy-shell ohmail.mail setUnread 7   # set the badge
omarchy-shell ohmail.mail refresh       # re-poll the source
omarchy-shell ohmail.mail open          # summon ohmail
```

The plugin's own IPC target is its id, so those go straight to it.
`omarchy-shell shell call ohmail.mail …` is a different mechanism and answers
`unknown` here — the widget registers a target, it does not export functions to
the shell target.

IPC arguments are strings on this surface, so the count arrives as text. A value
that is not a non-negative integer is ignored rather than shown.

> If you have just reinstalled or edited the plugin and IPC seems to do nothing,
> run `omarchy-restart-shell`. Omarchy's hot-reload can leave an older widget
> instance drawing while the IPC target moves to the new one, so pushes land
> somewhere you cannot see. A restart leaves exactly one.

**A pushed count stands until the next poll**, then the poll's answer wins. So a
pusher should push at least as often as `intervalMs`, or raise `intervalMs` and
own the number outright. The deliberate consequence: if the poll has no source,
a pushed number does eventually go back to "unknown" rather than sitting there
being stale. A count nothing is still asserting should stop being displayed.

## Licence

AGPL-3.0, the same as ohmail. See LICENSE.

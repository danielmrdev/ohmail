# Ohmail input focus on Omarchy: upstream issue check

Checked 2026-10-14 against GitHub's official Issues API and issue pages.

## Question and result

Does an open upstream issue report Ohmail's Add mailbox text fields failing to take click focus on Omarchy/Wayland?

**No directly matching open issue found** in the upstream Omarchy (`omacom/omarchy`) or Ohmail (`trafficflowhq/ohmail`) trackers. This is a search result, not proof that no unindexed or differently worded report exists. Ohmail's `upstream` remote is `trafficflowhq/ohmail`.

Local repro: both the downloaded upstream AppImage and this fork show the same failure. Both run natively on Wayland; local host reports Hyprland `0.56.2-2` and WebKitGTK `2.52.6-1`.

## Closest upstream reports

| Tracker | Issue | State | Relevance |
|---|---|---|---|
| Omarchy | [#9029 — Menu blocks on-screen keyboard input](https://github.com/omacom/omarchy/issues/9029) | Open | Related pointer/focus routing, but specifically a touchscreen on-screen keyboard whose clicks are intercepted by an Omarchy menu. Not ordinary mouse focus in an Ohmail form. |
| Omarchy | [#9756 — Bar panels dismiss when typing on an on-screen keyboard](https://github.com/omacom/omarchy/issues/9756) | Open | Similar only when typing through an on-screen keyboard into an Omarchy bar panel; not the reported Ohmail interaction. |
| Omarchy | [#14042 — Voice-to-text loses the intended text-field focus](https://github.com/omacom/omarchy/issues/14042) | Open | Focus changes during voice dictation after pointer movement; not click-to-focus failure. |
| Omarchy | [#15083 — Editable text fields make the shell read the clipboard](https://github.com/omacom/omarchy/issues/15083) | Open | Concerns clipboard reads by Qt Quick fields, not inability to focus or type. |
| Ohmail | [#9 — SIGSEGV in WebKitGTK on Hyprland + NVIDIA](https://github.com/trafficflowhq/ohmail/issues/9) | Closed 2026-10-13 | Same Omarchy/Hyprland/WebKitGTK versions, but symptom is a startup crash, not input focus. |

Ohmail's currently open issues are [#6 (RPM/Flatpak packages)](https://github.com/trafficflowhq/ohmail/issues/6) and [#8 (DavMail on localhost)](https://github.com/trafficflowhq/ohmail/issues/8); neither concerns focus or text input.

## Search scope

Checked open issues in both upstream trackers for focus, input, click, text-field, Wayland, WebKit, GTK, and Tauri terms. The Omarchy reports above are adjacent, not a confirmed cause. No source-backed basis to attribute this bug to Omarchy yet.

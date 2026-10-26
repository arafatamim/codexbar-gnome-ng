# CodexBar-NG for GNOME

Show AI provider usage in the GNOME panel. Reads quota windows from the
[codexbar](https://github.com/steipete/codexbar) CLI and renders the active
provider's session and weekly limits, reset times, pacing and local cost.

Fork of [InledGroup/codexbar-gnome](https://github.com/InledGroup/codexbar-gnome).

![CodexBar popup](<screenshot.png>)

## Features

- Per-provider quota windows with reset countdown, pace (reserve/deficit), and
  run-out projection
- Two-bar panel meter (session, weekly), or text segments for providers shown
  in the panel
- Provider tabs, account details, and cost totals for today and the last 30 days
- Provider logos bundled from the official CodexBar repository
- Custom providers: anything that prints codexbar JSON works
- English, Spanish and Brazilian Portuguese; times follow the desktop clock
  format

## Requirements

CodexBar CLI:

```bash
brew install steipete/tap/codexbar
```

Cookie importer, only for Codex:

```bash
mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-cookie-importer -o ~/.local/bin/codexbar-cookie-importer && chmod +x ~/.local/bin/codexbar-cookie-importer
```

Antigravity certificate helper, only for Antigravity. It elevates privileges to
install the language server certificate, which is why it stays a separate
script:

```bash
mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-ssl-helper -o ~/.local/bin/codexbar-ssl-helper && chmod +x ~/.local/bin/codexbar-ssl-helper && codexbar-ssl-helper
```

## Install

```bash
git clone https://github.com/arafatamim/codexbar-gnome-ng
cd codexbar-gnome-ng
./install.sh
```

Then reload the shell:

- Wayland: log out and back in, or run
  `dbus-run-session gnome-shell --wayland --devkit` (requires Mutter Devkit)
  for a nested, restartable session.
- X11: `Alt+F2`, type `r`, press Enter.

`extension.js` is imported once per shell process: disabling and enabling the
extension re-runs the cached module, so restart the shell (or devkit session)
to pick up code changes.

## Configuration

Settings live behind the gear icon in the popup, or in your extension manager.

### Providers

Providers already enabled in codexbar's own config are imported on start, so
there is nothing to add or enable again here. Turning a provider off in
Preferences records it and keeps it off.

### Provider commands

Each provider runs a command that prints JSON, for example:

```bash
codexbar --provider gemini --source api --format json
```

A bare `codexbar` is resolved from common install paths (Homebrew, `~/.local/bin`,
`/usr/local/bin`, `/usr/bin`) because the shell's `PATH` is shorter than a
terminal's.

### API keys

Providers authenticated by environment variable (for example OpenRouter with
`--source api` and `OPENROUTER_API_KEY`) need the variable in GNOME Shell's
environment, not your shell's dotfiles:

```bash
mkdir -p ~/.config/environment.d
echo 'OPENROUTER_API_KEY=sk-or-v1-...' > ~/.config/environment.d/codexbar.conf
chmod 600 ~/.config/environment.d/codexbar.conf
systemctl --user import-environment OPENROUTER_API_KEY
```

Log out and back in for `environment.d` to be read. Verify with:

```bash
tr '\0' '\n' < /proc/$(pgrep -x gnome-shell)/environ | grep OPENROUTER_API_KEY
```

### Display

- **Remaining** (default) or **Used**: whether bars and numbers count quota left
  or consumed.
- The panel meter shows the session window on top and the weekly window below,
  drawn in the panel's own text colour, so it stays monochrome and follows the
  panel's dynamic tint.
- Every provider icon from
  [CodexBar's Resources](https://github.com/steipete/CodexBar/tree/main/Sources/CodexBar/Resources)
  is bundled, so logos appear instantly and offline. Providers added upstream
  after a release fall back to [codexbar.app](https://codexbar.app/logos/), then
  the
  [ACP agent registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json),
  cached under `~/.cache/codexbar/logos` for a month.

## Differences from upstream

- **Bars that fit the panel.** Session and weekly quotas at a glance — no
  battery, no averaged percentage — and the fill follows light, dark and tinted
  panels.
- **A popup you can read.** One percentage per window, a warning icon only when
  a limit gets close, and local spend for today and the last 30 days.
- **Logos, handled for you.** Provider icons from the official CodexBar
  repository are bundled, with remote art as backup for new providers.
- **Calls that just work.** Commands are parsed and quoted, `codexbar` is found
  automatically, `--format json` is filled in when missing, and errors read as
  plain sentences.
- **Times that match your desktop.** Your clock format, relative "updated",
  compact durations, whole percentages.
- **Your codexbar setup, already here.** Providers enabled in codexbar's config
  show up on start; turning one off in Preferences keeps it off.
- **Less friction.** Install hints and a confirm-before-remove in preferences,
  plus a fixed cookie-based API path.

## Attribution

Based on [codexbar-gnome](https://github.com/InledGroup/codexbar-gnome) by Inled
Group, itself a GNOME port of [CodexBar](https://github.com/steipete/codexbar) by
[@steipete](https://github.com/steipete).

## License

[MIT-INLED](https://license.inled.es). If you base your code on this project or
remix it with AI, credit the original repository.

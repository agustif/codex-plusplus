# Dual-Channel Patching Evidence

Date: 2026-05-01.

## Goal

Patch and keep both installed Codex Desktop channels usable:

- Stable: `/Applications/Codex.app`.
- Beta: `/Applications/Codex (Beta).app`.

## Stable

Status command:

```sh
node packages/installer/dist/cli.js status
```

Verified state:

- User dir: `/Users/af/Library/Application Support/codex-plusplus`.
- App root: `/Applications/Codex.app`.
- Codex version: `26.429.20946`.
- Channel: `stable`.
- Bundle id: `com.openai.codex`.
- Fuse flipped: `true`.
- Resigned: `true`.
- Watcher: `launchd`.
- Current asar: matches patched.
- Plist hash: OK.
- Asar fuse: off.

## Beta

Beta uses a separate Codex++ home so stable and beta do not fight over one
install state:

```sh
export CODEX_PLUSPLUS_HOME="/Users/af/Library/Application Support/codex-plusplus-beta"
node packages/installer/dist/cli.js status
```

Verified state:

- User dir: `/Users/af/Library/Application Support/codex-plusplus-beta`.
- App root: `/Applications/Codex (Beta).app`.
- Codex version: `26.429.21146`.
- Channel: `beta`.
- Bundle id: `com.openai.codex.beta`.
- Fuse flipped: `true`.
- Resigned: `true`.
- Watcher: `launchd`.
- Current asar: matches patched.
- Plist hash: OK.
- Asar fuse: off.

Beta shares the stable tweak folder through a symlink:

```sh
/Users/af/Library/Application Support/codex-plusplus-beta/tweaks
```

points to:

```sh
/Users/af/Library/Application Support/codex-plusplus/tweaks
```

## Repair Commands

Stable repair:

```sh
node packages/installer/dist/cli.js repair --force
```

Beta repair:

```sh
beta_home="/Users/af/Library/Application Support/codex-plusplus-beta"
mkdir -p "$beta_home"
if [ ! -e "$beta_home/tweaks" ]; then
  ln -s "/Users/af/Library/Application Support/codex-plusplus/tweaks" "$beta_home/tweaks"
fi
CODEX_PLUSPLUS_HOME="$beta_home" \
  node packages/installer/dist/cli.js repair --force --app "/Applications/Codex (Beta).app"
```

## Important CLI Constraint

`repair` accepts `--app`; `status` does not. Beta status must be checked by
setting `CODEX_PLUSPLUS_HOME` to the beta user dir, then running plain
`status`.

## Important Launch Constraint

Stable executable:

```sh
/Applications/Codex.app/Contents/MacOS/Codex
```

Beta executable:

```sh
/Applications/Codex (Beta).app/Contents/MacOS/Codex (Beta)
```

The beta executable is not named `Codex`; launching
`/Applications/Codex (Beta).app/Contents/MacOS/Codex` fails with
`no such file or directory`.

Both patched app bundles record their own Codex++ runtime root in
`package.json#__codexpp.userRoot`, so normal launches do not need
`CODEX_PLUSPLUS_HOME`:

- Stable: `/Users/af/Library/Application Support/codex-plusplus`.
- Beta: `/Users/af/Library/Application Support/codex-plusplus-beta`.

## Update Drift Root Cause

Stable Codex++ niceties vanished because Sparkle replaced the patched
`26.422` app bundle with a clean signed `26.429` app. The clean app did not
contain `codex-plusplus-loader.cjs`, so the Codex++ runtime did not load.

The watcher tried to recover but masked a failed repair:

- The watcher command includes `|| true`, so launchd can report success even
  when `repair` failed.
- The failure was an App Management/EPERM write-probe failure under
  `/Applications/Codex.app/Contents/Resources`.

Product implication: Codex++ needs an in-app and CLI-visible update health
state that distinguishes:

- app updated and patch missing,
- repair blocked by permissions,
- watcher ran and repaired,
- watcher failed but launchd masked it,
- patched on disk but runtime not observed.

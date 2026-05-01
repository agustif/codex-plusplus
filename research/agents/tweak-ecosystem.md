# Tweak Ecosystem Research Notes

Scope: product and platform ideas for Codex++ tweaks/plugins. Evidence is anchored to the current repo state, especially `packages/sdk`, `packages/runtime`, `packages/installer`, and authoring docs. This file is notes-only; it does not propose code changes in this slice.

## 1. Best Immediate Wins

1. Ship a local "tweak catalog" before a remote marketplace.
   - Current install/discovery is already local-folder based: a tweak is a folder with `manifest.json` plus an entry file under the user tweaks dir, and the manager renders what loads from that location. Evidence: `docs/WRITING-TWEAKS.md:3-9`, `packages/runtime/src/tweak-discovery.ts:1-9`, `packages/runtime/src/tweak-discovery.ts:22-41`.
   - Product move: add a catalog page that indexes installed tweaks, default tweaks, disabled tweaks, update status, permissions, source repo, homepage, author, tags, scope, MCP server, and storage footprint. This can be backed by the already-returned `codexpp:list-tweaks` shape: manifest, entry, dir, entryExists, enabled, and update metadata. Evidence: `packages/runtime/src/main.ts:435-445`, `packages/runtime/src/preload/tweak-host.ts:25-40`.
   - Why first: it gives the marketplace UX shape without introducing remote install trust decisions yet.

2. Treat permissions as first-class UX now, even before hard enforcement is complete.
   - The manifest already supports `permissions`, and the SDK enumerates known strings: `ipc`, `filesystem`, `network`, `settings`, `codex.windows`, `codex.views`, and `git.metadata`. Evidence: `packages/sdk/src/index.ts:44-50`, `packages/sdk/src/index.ts:64-83`.
   - The validator only checks that listed permissions are known; it does not currently block API access for most capabilities. Git is the clearest gated API: renderer `api.git` is only exposed when `manifest.permissions` includes `git.metadata`. Evidence: `packages/sdk/src/index.ts:169-185`, `packages/runtime/src/preload/tweak-host.ts:160-218`.
   - Product move: show "declared" vs "currently enforced" permission badges. Do not imply sandbox guarantees that do not exist. Use labels like "Git metadata: required and gated", "Filesystem: scoped to tweak data dir", "IPC: namespaced channel", and "Network: declared by author, not runtime blocked yet".

3. Expand trust UX around advisory updates instead of installing updates automatically.
   - Current update policy is deliberately manual: manifests require `githubRepo`; update checks hit GitHub Releases at most daily; the runtime only reports availability and never auto-installs tweak updates. Evidence: `packages/sdk/src/index.ts:16-21`, `docs/ARCHITECTURE.md:37-42`, `docs/WRITING-TWEAKS.md:63-67`, `packages/runtime/src/main.ts:757-788`.
   - Product move: an "Update Available" details drawer should show current version, latest tag, checkedAt, release URL, repo owner/name, release-notes excerpt, and a manual "Open release" action. The open-external handler already limits metadata links to `https://github.com`. Evidence: `packages/runtime/src/main.ts:578-583`.
   - Trust move: add warnings for repo mismatch, missing release, non-semver version, unverified author metadata, or update-check error. The SDK already produces semver warnings and GitHub repo validation errors. Evidence: `packages/sdk/src/index.ts:120-135`.

4. Make the bundled/default tweak lane visible and reversible.
   - The installer seeds default tweaks from external GitHub release tarballs, skips if the local folder already exists, and strips `.git` and `node_modules` during copy. Evidence: `docs/ARCHITECTURE.md:43-45`, `packages/installer/src/default-tweaks.ts:14-23`, `packages/installer/src/default-tweaks.ts:34-55`, `packages/installer/src/default-tweaks.ts:118-123`.
   - Product move: the manager should label default tweaks as "Bundled by Codex++ installer" or "Default catalog", not as app-internal code. Existing local tweak folders are not overwritten, so users need "reset/reinstall default tweak" as a future explicit action rather than silent replacement.
   - Trust move: for default tweaks, show source repo and release provenance in the same format as third-party tweaks. Defaults should not get a hidden trust path.

5. Turn `dev` into a polished developer mode, not just a CLI command.
   - The CLI can validate a manifest, symlink a tweak into the tweaks dir, write a reload marker, and optionally watch source changes while ignoring `node_modules`. Evidence: `packages/installer/src/commands/dev-tweak.ts:24-45`, `packages/installer/src/commands/dev-tweak.ts:79-100`, `packages/installer/src/commands/dev-tweak.ts:124-147`.
   - Runtime also has a manual force-reload IPC path and a chokidar watcher that debounces changes and broadcasts reloads to renderers. Evidence: `packages/runtime/src/main.ts:591-610`, `packages/runtime/src/main.ts:613-628`, `packages/runtime/src/main.ts:845-857`.
   - Product move: add a "Developer Mode" panel showing linked tweak source, symlink target, last validation result, last reload reason, last error, and a force reload button. This can be built from existing CLI/runtime primitives before new APIs.

6. Document the API maturity levels beside the SDK types.
   - SDK API surface currently spans settings pages/sections, React fiber utilities, IPC, filesystem, storage, git metadata, logging, and main-process Codex window/view APIs. Evidence: `packages/sdk/src/index.ts:262-284`, `packages/sdk/src/index.ts:300-341`, `packages/sdk/src/index.ts:347-385`, `packages/sdk/src/index.ts:387-430`.
   - Some APIs are more stable than others. Settings and storage are product primitives; React fiber access is intentionally advanced and brittle; Codex window services depend on patched host internals. Evidence: `docs/WRITING-TWEAKS.md:93-101`, `docs/ARCHITECTURE.md:117-121`.
   - Product move: tag APIs as Stable, Advanced, Experimental, or Host-internal. This will reduce marketplace review ambiguity and help tweak authors avoid brittle hooks when a supported extension point exists.

7. Make storage behavior honest and inspectable.
   - Runtime main storage is disk-backed JSON under `<userRoot>/storage/<id>.json`, debounced and atomic; renderer storage currently uses `localStorage`; filesystem helpers are scoped to `<userRoot>/tweak-data/<id>/`. Evidence: `packages/runtime/src/storage.ts:1-7`, `packages/runtime/src/storage.ts:27-87`, `packages/runtime/src/preload/tweak-host.ts:221-245`, `packages/runtime/src/main.ts:535-552`, `docs/WRITING-TWEAKS.md:145-147`.
   - The docs still say main storage is currently in-memory and will move to disk, which appears stale against `createDiskStorage`. Evidence: `docs/WRITING-TWEAKS.md:103-106`, `packages/runtime/src/main.ts:657-670`.
   - Product move: expose "data stored by this tweak" with paths and clear-data actions. Documentation move for a later slice: update the storage docs to match the implementation.

8. Expose MCP integration as a trust-sensitive capability, not just a manifest field.
   - Tweaks can declare an optional MCP server in the manifest; Codex++ syncs enabled tweak MCP servers into `~/.codex/config.toml` inside a managed block. Evidence: `packages/sdk/src/index.ts:44-48`, `packages/runtime/src/mcp-sync.ts:5-7`, `packages/runtime/src/main.ts:680-698`.
   - The MCP sync respects manually configured server names, reserves unique names, resolves relative commands/args against the tweak dir, and writes env vars into the config. Evidence: `packages/runtime/src/mcp-sync.ts:49-69`, `packages/runtime/src/mcp-sync.ts:141-155`, `packages/runtime/src/mcp-sync.ts:158-167`.
   - Product move: show MCP as "adds chat tools" with command, args, env key names, and config destination. Hide env values by default. Require explicit enablement for third-party MCP servers even if the tweak itself is enabled.

## 2. Medium Bets

1. Marketplace model: GitHub-release registry with local install receipts.
   - Fit with current architecture: manifests already require `githubRepo`, release checks already use GitHub Releases, default tweaks already install from GitHub release tarballs, and Codex++ self-update already downloads GitHub release source. Evidence: `packages/runtime/src/main.ts:790-828`, `packages/installer/src/default-tweaks.ts:77-95`, `packages/installer/src/commands/self-update.ts:121-150`.
   - Proposed registry primitive: a signed or reviewed JSON index containing id, name, repo, latest version, tags, permission summary, MCP summary, default/bundled flag, screenshots, and review status. Actual install still downloads a release artifact and validates `manifest.json`.
   - Keep phase 1 GitHub-native: do not invent accounts, payments, or package hosting until the trust UX and install receipt model are correct.

2. Install receipts and provenance checks.
   - Current default-tweak install copies release contents into the tweaks dir but does not appear to write a provenance receipt per tweak. Evidence: `packages/installer/src/default-tweaks.ts:58-75`, `packages/installer/src/default-tweaks.ts:118-123`.
   - Proposed receipt: `<tweak-data or metadata>/<id>/install.json` with source kind, repo, release tag, asset URL, digest, installedAt, installer version, manifest snapshot, and whether installed by default, marketplace, dev symlink, or manual copy.
   - UX impact: trust panel can distinguish "manually dropped folder" from "installed from reviewed catalog release".

3. Permission enforcement in the runtime API factory.
   - Renderer git is currently permission gated; renderer fs/ipc/settings/storage are provided regardless of declared permissions. Main tweaks receive git, codex, fs, ipc, storage, and log unconditionally once loaded. Evidence: `packages/runtime/src/preload/tweak-host.ts:160-218`, `packages/runtime/src/main.ts:653-667`.
   - Proposed enforcement order: warn-only in catalog, deny newly dangerous APIs for unlisted permissions in dev builds, then require permissions for marketplace-installed tweaks. Keep manual/local tweaks flexible behind developer mode.
   - Avoid overclaiming: JavaScript running in preload/main still has broad possibilities. The permission system is an API exposure and review contract, not a perfect sandbox.

4. Tweak signing or digest pinning before one-click install.
   - Today the safest path is manual update review because the runtime never auto-installs tweak updates. Evidence: `docs/ARCHITECTURE.md:37-42`.
   - For marketplace install, require release artifact digest pinning at minimum. For higher trust, accept Sigstore/GitHub artifact attestations or a Codex++ registry signature.
   - Product decision: if unsigned, install can still be allowed in developer mode but should show a clear "unverified source" state.

5. Marketplace review pipeline focused on declared behavior, not full code ownership.
   - Manifest schema gives enough hooks for automated review: id/name/version/repo, scope, permissions, MCP, tags, minRuntime, entry. Evidence: `packages/sdk/src/index.ts:9-51`, `packages/sdk/src/index.ts:96-187`, `packages/installer/src/commands/validate-tweak.ts:8-40`.
   - Review bot can run `validate-tweak`, inspect package size, detect bundled dependencies, extract MCP command/env names, lint for obvious network/process/fs use, and render a static trust card.
   - The marketplace should not imply full security audit unless there is a real audit process.

6. Runtime compatibility and deprecation channels.
   - Manifests include `minRuntime`, but discovery currently only validates id/name/version/githubRepo/scope and does not appear to reject incompatible runtime ranges. Evidence: `packages/sdk/src/index.ts:38-43`, `packages/runtime/src/tweak-discovery.ts:44-49`.
   - Product move: manager should warn on unknown/newer `minRuntime` now; later runtime should refuse incompatible marketplace installs.
   - Platform move: maintain SDK changelog plus compatibility matrix for Stable vs Experimental APIs.

7. Storage migration and backup UX.
   - Main storage now uses disk JSON with corrupt-file preservation; renderer storage uses localStorage and is less discoverable/portable. Evidence: `packages/runtime/src/storage.ts:32-44`, `packages/runtime/src/preload/tweak-host.ts:221-245`.
   - Medium bet: move renderer storage through main IPC to the same disk-backed store, then make "export tweak data", "clear tweak data", and "include in backup" consistent.

8. Safer filesystem and path handling.
   - Renderer filesystem IPC rejects ids outside a pattern and rejects paths containing `..`, then joins under `<userRoot>/tweak-data/<id>`. Evidence: `packages/runtime/src/main.ts:535-552`.
   - Medium bet: replace substring traversal checks with `resolve` plus prefix checks, matching the stricter asset-source checks. Evidence for stricter pattern: `packages/runtime/src/main.ts:474-483`, `packages/runtime/src/main.ts:490-523`.

## 3. Wild Ideas Or Moonshots

1. "Tweak Studio" inside Codex++.
   - Build a local authoring surface that scaffolds via `create-tweak`, runs validation, links via `dev`, watches reloads, displays logs, and includes starter components for settings pages. CLI primitives already exist. Evidence: `packages/installer/src/cli.ts:129-150`, `packages/installer/src/commands/create-tweak.ts:18-79`, `packages/installer/src/commands/dev-tweak.ts:24-45`.

2. Capability-scoped MCP marketplace.
   - Tweak marketplace entries could expose both UI extensions and chat/tool extensions. MCP servers declared by tweaks already sync into Codex config. Evidence: `packages/runtime/src/mcp-sync.ts:26-43`, `packages/runtime/src/mcp-sync.ts:141-155`.
   - Long-term UX: users install "workspace tools" with explicit chat-tool permissions, then enable them per project/repo.

3. Trust scorecards generated from release artifacts.
   - For every candidate tweak release, generate a scorecard: manifest validity, permissions, API usage, MCP command, env keys, package size, dependency tree, source repo age, signed tags, release digest, and screenshots.
   - Keep the scorecard evidence-based and avoid opaque star ratings.

4. Tweak collections.
   - Let users install curated sets like "Git workflow", "UI polish", "Agent ops", or "Research dashboard". Default tweaks are already an implicit collection of two repos. Evidence: `packages/installer/src/default-tweaks.ts:14-23`.
   - Trust caveat: collection install must still show individual permission/MCP/storage/repo cards.

5. Per-workspace enablement.
   - Today enablement appears global in `config.json`, keyed by tweak id, with safe mode globally disabling all tweaks. Evidence: `packages/runtime/src/main.ts:126-134`, `packages/installer/src/commands/safe-mode.ts:36-48`.
   - A future project profile could enable a tweak only for selected repos, especially for git/MCP/network-heavy tools.

## 4. Constraints And Exact Evidence

1. Distribution is currently local and GitHub-release-oriented.
   - Local tweak folders: `docs/WRITING-TWEAKS.md:3-9`.
   - Default tweaks from GitHub releases: `packages/installer/src/default-tweaks.ts:34-75`.
   - Self-update from GitHub latest release/source tarball: `packages/installer/src/commands/self-update.ts:68-83`.

2. No automatic third-party tweak updates today.
   - SDK manifest comment: `packages/sdk/src/index.ts:16-21`.
   - Architecture doc: `docs/ARCHITECTURE.md:37-42`.
   - Runtime update check cache/write: `packages/runtime/src/main.ts:757-788`.

3. Runtime loading model has real trust implications.
   - Renderer tweak source is read by main and evaluated with `new Function` in preload because the renderer is sandboxed and cannot require arbitrary files. Evidence: `packages/runtime/src/preload/tweak-host.ts:1-13`, `packages/runtime/src/preload/tweak-host.ts:104-124`.
   - Main-scope tweaks are loaded with `require(t.entry)` and receive main APIs. Evidence: `packages/runtime/src/main.ts:647-667`.
   - Therefore marketplace UX must be explicit that a tweak is executable code, not a declarative theme.

4. Settings/UI integration is heuristic and should be presented as best-effort.
   - The injector identifies Codex settings by DOM text/content and injects sidebar groups/panels. Evidence: `packages/runtime/src/preload/settings-injector.ts:1-22`, `packages/runtime/src/preload/settings-injector.ts:298-320`.
   - Architecture docs acknowledge settings DOM changes can break injection. Evidence: `docs/ARCHITECTURE.md:117-121`.

5. Safe mode and per-tweak enablement are already available trust controls.
   - Global safe mode disables all tweaks until turned off and preserves per-tweak flags. Evidence: `packages/installer/src/commands/safe-mode.ts:36-48`.
   - Runtime checks safe mode before considering per-tweak enabled flags. Evidence: `packages/runtime/src/main.ts:126-134`.

6. MCP sync modifies user Codex config, so it needs unusually clear consent.
   - Config path is `~/.codex/config.toml` from runtime main. Evidence: `packages/runtime/src/main.ts:36-37`.
   - Managed block markers are explicit and merge preserves manual config outside the block. Evidence: `packages/runtime/src/mcp-sync.ts:5-7`, `packages/runtime/src/mcp-sync.ts:82-95`.
   - Existing manual MCP names are detected and skipped. Evidence: `packages/runtime/src/mcp-sync.ts:49-69`.

7. Git metadata is the best current model for privacy-preserving APIs.
   - Docs say the git API returns structured metadata and intentionally avoids raw diff hunks, file contents, credentials, and ignored trees by default. Evidence: `docs/WRITING-TWEAKS.md:128-143`.
   - Implementation uses bounded git subprocesses with default timeout and output caps. Evidence: `packages/runtime/src/git-metadata.ts:1-5`, `packages/runtime/src/git-metadata.ts:175-200`, `packages/runtime/src/git-metadata.ts:216-240`.

8. Installer patching is invasive but designed to be reversible/repairable.
   - Architecture: app asar entry is patched, loader injected, fuse changed, plist integrity updated, runtime lives in user dir. Evidence: `docs/ARCHITECTURE.md:3-35`.
   - Installer backs up originals before patching, stages runtime, injects loader, updates integrity, flips fuse, and signs. Evidence: `packages/installer/src/commands/install.ts:61-99`.
   - Product trust UX should separate "Codex++ system patch trust" from "individual tweak trust".

## 5. Suggested Next Slice

1. Write a product spec for a local Tweak Center:
   - Installed catalog.
   - Default tweak provenance.
   - Permission and MCP badges.
   - Update details drawer.
   - Dev mode panel.
   - Safe mode status.
   - Storage/data controls.

2. Add a machine-readable trust card schema before implementing UI:
   - Inputs: manifest, discovery result, update check, install receipt if present, validation warnings/errors, MCP sync summary, storage paths, enabled state, default/dev/manual source.
   - Output: stable JSON that UI, CLI `status`, and future marketplace can render consistently.

3. Tighten docs to match runtime truth:
   - Update storage docs because main storage appears disk-backed now, not in-memory.
   - Mark React fiber and Codex window APIs as advanced/experimental.
   - Add explicit "tweaks are executable code" trust language.

4. Build marketplace in three phases:
   - Phase 1: local catalog plus GitHub release update UX; no remote install.
   - Phase 2: reviewed registry with manual download/open-release flow and install receipts.
   - Phase 3: one-click install gated by digest/signature/provenance checks and explicit permission/MCP consent.

5. Highest-risk implementation questions to answer before one-click distribution:
   - Should marketplace-installed tweaks be required to declare all used permissions?
   - Should MCP servers require separate consent from tweak enablement?
   - Where should install receipts live: `state.json`, per-tweak metadata, or a new registry DB?
   - Can renderer storage be migrated to disk-backed IPC without breaking existing localStorage-backed tweaks?
   - What is the minimum attestation standard for a "reviewed" tweak: digest pin, signed release, GitHub provenance, or Codex++ registry signature?

# Codex++ Product Research

This folder is the working product/reverse-engineering map for Codex++.

## Structure

- `agents/`: one note per exploration lane, written by the agent that owned it.
- `synthesis/`: integrated product roadmap, constraints, and prioritization.
- `evidence/`: exact commands, local observations, protocol facts, and bundle anchors.

## Scoring

Each idea should be tagged with:

- `Impact`: low, medium, high, or moonshot.
- `Effort`: small, medium, large, or research.
- `Confidence`: low, medium, or high.
- `Dependency`: native Codex seam, Codex++ runtime seam, app-server protocol, or external service.

## Current Context

Stable Codex.app is patched with Codex++ against Codex Desktop
`26.429.20946`. Beta Codex is patched separately at
`/Applications/Codex (Beta).app` against `26.429.21146`. Both embedded
app-servers report `codex-cli 0.128.0-alpha.1` and include the `goals`
feature flag. Codex++ now has in-flight support for:

- `/goal` frontend handling via a preload bridge to `thread/goal/*`.
- A composer-anchored `/goal` command suggestion shim.
- A read-only git metadata provider exposed through `api.git` with the
  `git.metadata` tweak permission.
- Dual stable/beta patching through separate Codex++ homes and shared tweaks.

## Integrated Outputs

- `synthesis/product-roadmap.md`: ordered product plan.
- `synthesis/constraints-map.md`: stable seams, hard constraints, and product consequences.
- `evidence/current-state.md`: exact installed app/config/repo verification.
- `evidence/dual-channel-patching.md`: stable/beta patch commands and findings.

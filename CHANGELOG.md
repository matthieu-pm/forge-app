# Changelog

All notable changes to Forge will be documented in this file.

## Unreleased

### Added

- Added the shared Forge agent workspace for web and macOS, with a centered
  composer, compact and maximized chat, searchable history, attachments, and
  structured transcript rendering for tools, code, approvals, and artifacts.
- Added an isolated EVE runtime for typed tools, sandboxed code execution, and
  programmatic Forge capability calls.
- Added durable agent threads, runs, events, approvals, artifacts, attachments,
  model preferences, and connection metadata.
- Added approval-gated, idempotent, and audited write capabilities with
  workspace-scoped authorization.
- Added Forge-managed OpenAI, OpenAI-only Auto routing, API-key connections for
  supported providers, custom OpenAI- and Anthropic-compatible endpoints, and
  local Codex subscription support in the macOS app.
- Added AI & Agents and Profile settings, including provider connections, model
  discovery, local runtime status, and reasoning-effort selection.
- Added agent release evals, retention tooling, diagnostics, security coverage,
  and Electron model-broker tests.

### Changed

- Changed `bun run dev` to start the web app and agent runtime together, and
  updated desktop development to run the same shared stack.
- Reworked the Forge home into an agent-first composer that opens conversations
  over the current workspace without route changes.
- Expanded agent configuration with feature flags, provider and capability
  allowlists, run limits, concurrency controls, budgets, and retention settings.

### Security

- Added short-lived run-bound tokens, encrypted model credentials, endpoint
  validation, bounded event redaction, Electron sender validation, and isolated
  sandbox execution without Forge or database credentials.

## v0.0.1 - 2026-07-22

### Added

- Published the initial Forge build for web and macOS.
- Added issue tracking across inbox, personal, workspace, and team views.
- Added the early agent workspace for agent-driven workflows and automation.

### Changed

- Tagged the current build as `v0.0.1`.

## 2026-06-09

### Changed

- Updated the sidebar workspace menu to match the current app styling.
- Made the menu more compact while keeping the finalized width and rounded dropdown treatment.
- Removed the email address and separator from the workspace menu header.

### Added

- Added `Settings` and `Upgrade plan` actions to the workspace menu.

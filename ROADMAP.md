# Artifact Atlas — Product & Engineering Roadmap

## Milestone 0 — Repository Foundation (Completed)
- [x] Initialize repository structure, `.gitignore`, `package.json`, and `Package.swift`.
- [x] Document architecture (`ARCHITECTURE.md`), roadmap (`ROADMAP.md`), and agent instructions (`AGENTS.md`).
- [x] Establish automated test and verification harness (`npm test` / `swift test`).

## Milestone 1 — Functional User Interface (Completed)
- [x] Minimal Empty Workspace with central `.app` drag-and-drop zone, "Choose Application" picker, "Analyze Workspace Directory" picker, and Settings modal.
- [x] Obsidian-inspired Interactive Knowledge Graph (HTML5 Canvas with physics layout, zoom, pan, node dragging, hover tooltips, focus mode, cluster gravity, and dark/light theme support).
- [x] Provenance Path Highlighting (dims unrelated nodes, traces upstream/downstream provenance hops with distinct visual styling for `VERIFIED`, `INFERRED`, and `UNKNOWN` edges).
- [x] Right-hand Contextual Provenance & Evidence Inspector and bottom Contextual Action Toolbar.

## Milestone 2 — Real Artifact Discovery (Completed)
- [x] Passive `.app` bundle recognition via `Contents/Info.plist` parsing without executing binaries.
- [x] Permission-aware, cancellable filesystem scanner with symlink boundary protection and physical inode (`dev:ino`) hardlink deduplication.
- [x] Multi-factor deterministic `ClassificationEngine` covering all 10 artifact types and 4 risk categories (`LOW`, `REVIEW`, `HIGH`, `PROTECTED`).

## Milestone 3 — Provenance Engine & Validated Adapters (Completed)
- [x] Explicit `Evidence` model (`VERIFIED`, `INFERRED`, `UNKNOWN`) that never fabricates conversation-to-file links from timestamp proximity alone.
- [x] Validated session-aware adapters for **Claude Code** (`.claude/projects/.../*.jsonl` tool ledger), **Cursor** (`workspaceStorage` & composer metadata), **Codex CLI** (`rollout-*.jsonl` patch/shell ledger), and **Generic macOS Applications**.
- [x] Full support for many-to-many provenance (overlapping conversations creating and modifying shared files) and explicit `UNKNOWN_ORIGIN` nodes.

## Milestone 4 — Safe Cleanup & Quarantine Vault (Completed)
- [x] 10-step pre-removal verification (re-statting inode/mtime/size, symlink traversal rejection, protected location block, shared dependency warnings).
- [x] Recoverable Quarantine Vault with durable SQLite + JSON manifest persistence (`manifest.json`).
- [x] Conflict-aware restoration (`FAIL_IF_EXISTS`, `RENAME_RESTORED`, `OVERWRITE_IF_EXPLICIT`).

## Milestone 5 — Polish, Space Treemap & End-to-End Validation (Completed)
- [x] Interactive Space Treemap view with physical inode deduplication and click-to-focus synchronization with the Knowledge Graph.
- [x] Search, multi-facet filtering (Node Type, Risk Level, Confidence, Artifact Type), keyboard navigation, and accessibility support.
- [x] Comprehensive automated test suite covering all 17 safety, scanning, provenance, graph, and quarantine scenarios.

---

## Post-MVP Horizons

### Milestone 6 — Opt-In Live Provenance Monitor
- Implement `LiveMonitorProvider` using macOS `FSEvents` + active session JSONL tailing so file mutations occurring during an active Claude Code or Cursor tool invocation are correlated in real time.
- Maintain strict opt-in consent and zero privileged kernel hooks.

### Milestone 7 — Expanded AI Ecosystem Adapters
- Add validated adapters for **Windsurf**, **Continue.dev**, **Aider** (`.aider.chat.history.md`), **Zed AI**, **Ollama** (`~/.ollama/models` blob/manifest deduplication), and **LM Studio** (`~/.cache/lm-studio`).
- Content-addressable weight blob awareness so shared GGUF/Safetensors layers across multiple model manifests are visualized accurately.

### Milestone 8 — Cross-Platform Native Packaging
- Package signed & notarized macOS Universal `.dmg` bundle (`arm64` + `x86_64`).
- Add Windows (`%APPDATA%` / `%LOCALAPPDATA%`) and Linux (`$XDG_CONFIG_HOME` / `$XDG_CACHE_HOME`) platform path adapters on top of the existing `PlatformServices` abstraction.

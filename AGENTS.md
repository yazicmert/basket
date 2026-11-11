# AGENTS.md — Guidelines for AI Coding Agents Working in `basket` (Artifact Atlas)

## 1. Repository Mission & Non-Negotiable Safety Rules

**Artifact Atlas** is a safety-critical local filesystem provenance and cleanup tool. Any agent modifying this codebase must uphold these invariants:

1. **Never Execute Scanned Applications**: `.app` bundles dropped or selected by the user must only be inspected via static metadata (`Contents/Info.plist`, directory structure). Never spawn or execute binaries inside scanned bundles.
2. **Never Permanently Delete User Files**: All cleanup operations in `CleanupEngine` must move files into the managed Quarantine Vault with both a SQLite record and an on-disk `manifest.json` recovery descriptor.
3. **Never Fabricate Provenance**:
   - `VERIFIED` confidence requires a direct, structured reference in an authoritative log or ledger (e.g., an explicit tool call `Write` / `Edit` / `apply_patch` targeting the canonical path, or an explicit workspace mapping).
   - Timestamp proximity between a conversation and a file modification is **never** sufficient for `VERIFIED` provenance and must not automatically link unrelated files to a conversation.
   - When session-level origin is unknown, connect the artifact to an explicit `UNKNOWN_ORIGIN` node.
4. **Never Classify Deletion Safety by File Extension Alone**:
   - `ClassificationEngine` must inspect canonical path context, parent directory semantics, Git repository presence, provenance confidence, and shared dependency count.
   - Source code, `.git` directories, session transcripts, model weights/checkpoints, credentials, and multi-session shared files must never be classified as `LOW` risk.
5. **Respect Symlink Boundaries & Physical Inodes**:
   - Always use `lstat` (not `stat`) when walking directories.
   - Verify symlink targets with `realpath` against authorized scan roots before any optional resolution.
   - Deduplicate physical storage metrics by `${dev}:${ino}` so hardlinked files or multi-session files are never double-counted.
6. **Zero Raw Conversation Persistence**:
   - When parsing `.jsonl` transcripts or composer databases, extract only structural metadata (session ID, timestamps, workspace path, tool name, target file paths). Never copy user prompts or assistant prose into SQLite.

## 2. Project Layout

- `src/` — Portable Core & Local Desktop Application (Node.js 24 ESM + built-in `node:sqlite`):
  - `src/models/` — Versioned domain models and enumerations.
  - `src/platform/` — `PlatformServices` (filesystem boundary guards, symlink checks, inode identity, Finder reveal).
  - `src/discovery/` — `ApplicationDiscovery` (`.app/Contents/Info.plist` parser and app identity resolver).
  - `src/adapters/` — `AdapterRegistry` + `ClaudeCodeAdapter`, `CursorAdapter`, `CodexAdapter`, `GenericMacOSAppAdapter`.
  - `src/scanner/` — Cancellable, permission-aware filesystem `Scanner`.
  - `src/indexer/` — `ArtifactIndexer` with physical inode deduplication.
  - `src/provenance/` — `ProvenanceEngine` (`VERIFIED` / `INFERRED` / `UNKNOWN` evidence builder).
  - `src/classification/` — Deterministic `ClassificationEngine` (10 artifact types, 4 risk levels).
  - `src/graph/` — `GraphEngine` (Knowledge Graph builder, multi-hop provenance tracer, Treemap aggregator).
  - `src/cleanup/` — `CleanupEngine` (10-step pre-flight validator, Quarantine Vault, conflict-safe restore).
  - `src/persistence/` — SQLite `Persistence` engine with numbered migrations.
  - `src/monitoring/` — `LiveMonitorProvider` interfaces for future opt-in live event correlation.
  - `src/fixtures/` — Deterministic synthetic & real-filesystem demo environment generator.
  - `src/ui/` — Local HTTP/IPC server (`server.js`) and Obsidian-inspired Knowledge Graph & Treemap UI (`public/`).
  - `src/cli.js` — Command-line entrypoint (`serve`, `scan`, `demo`, `quarantine`, `restore`).
- `Sources/` & `Tests/` — Native macOS Swift Package (`ArtifactAtlasCore`, `ArtifactAtlasApp`, `ArtifactAtlasCoreTests`).
- `tests/` — Portable Core automated test suite executed via `node --test`.

## 3. Build, Run & Test Commands

- **Run all automated tests (Portable Core on Linux/macOS)**:
  ```bash
  npm test
  ```
- **Start the Artifact Atlas interactive desktop UI server**:
  ```bash
  npm start
  ```
- **Build & test native macOS Swift target (requires macOS 14+ with Xcode / Swift 5.10+)**:
  ```bash
  swift build
  swift test
  ```

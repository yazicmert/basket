# Artifact Atlas — AI Artifact Provenance & Cleanup Explorer

> **Know what created a file, why it exists, whether it is still needed, and what happens if it is removed.**

**Artifact Atlas** is a local-first, privacy-preserving desktop explorer that discovers, traces, visualizes, and safely manages filesystem artifacts associated with AI applications and AI-assisted development workflows (`Claude Code`, `Claude Desktop`, `Cursor`, `Codex CLI`, and generic macOS `.app` bundles).

---

## Core Principles & Safety Guarantees

1. **100% Local-First & Privacy-First**: No cloud accounts, no telemetry, no external AI APIs, and zero uploading of conversation histories or file contents.
2. **Passive Application Identification**: Dropped `.app` bundles are identified strictly via static bundle metadata (`Contents/Info.plist`) and are **never executed**.
3. **Epistemic Honesty in Provenance**:
   - **`VERIFIED`**: Backed by a direct tool-invocation record in an authoritative session transcript or composer ledger (`Write`, `Edit`, `MultiEdit`, `apply_patch`), or the authoritative transcript file itself.
   - **`INFERRED`**: Backed by indirect structural evidence (e.g., dedicated application cache/log container, session ID embedded in path, or build output derived from a verified source file).
   - **`UNKNOWN`**: Unattributed files are explicitly linked to an `UNKNOWN_ORIGIN` node. **Timestamp proximity alone never fabricates a conversation-to-file link.**
4. **Multi-Factor Risk Classification**: Filename extension alone (e.g., `.tmp` or `.log`) never grants `LOW` deletion risk. The classifier evaluates canonical directory context, Git repository proximity, provenance confidence, physical hardlinks, and multi-session sharing.
5. **Recoverable Quarantine over Permanent Deletion**: Selecting **Delete (Move to Quarantine)** runs a 10-step pre-flight verification (re-checking inode identity, file size, modification timestamp, permissions, and symlink traversal) and moves eligible files into a managed Quarantine Vault with both a SQLite record and an on-disk `manifest.json` recovery file.

---

## Quick Start (Portable Core & Interactive Desktop UI)

Artifact Atlas runs with **zero external npm dependencies** on **Node.js 22.5+ / 24 LTS** (using built-in `node:sqlite`, `node:fs`, `node:crypto`, `node:http`, and `node:test`).

### 1. Run Automated Safety & Integration Tests
```bash
npm test
```

### 2. Run the End-to-End Vertical Slice CLI Verification
Executes the full lifecycle (**Drop `.app` → Discover artifacts → Build graph → Inspect multi-session provenance → Review cleanup → Quarantine → Restore**) against real files on disk in an isolated temporary sandbox:
```bash
npm run demo
```

### 3. Launch the Interactive Desktop UI
```bash
npm start
# Or specify a custom port or real home directory:
node src/cli.js serve --port 4310
```
Then open `http://localhost:4310` to use the interactive Empty Workspace dropzone, Obsidian-inspired Knowledge Graph, Space Treemap, Provenance Inspector, and Quarantine Vault.

### 4. Scan a Specific `.app` Bundle or Project Directory from CLI
```bash
node src/cli.js scan /Applications/Claude.app
node src/cli.js scan ~/Projects/my-ai-workspace
```

---

## Native macOS Swift Target (`SwiftUI` + `SQLite3`)

For native macOS 14+ (Sonoma / Sequoia) builds using Xcode 15.4+ or Swift 5.10+:

```bash
swift build
swift test
swift run ArtifactAtlasApp
```

> **Environment Note**: When developing or running CI on a Linux host without Apple's macOS SDK (`AppKit`/`SwiftUI`), use the Portable Core commands (`npm test`, `npm run demo`, `npm start`) which exercise the complete 11-module architecture against real POSIX filesystems and SQLite.

---

## Architecture Overview

The repository is structured into 11 decoupled components (documented in detail in [ARCHITECTURE.md](file:///home/antigravity/yazicmert/basket/ARCHITECTURE.md)):

| Component | Portable Core (`src/`) | Native macOS (`Sources/`) | Responsibility |
| :--- | :--- | :--- | :--- |
| **PlatformServices** | `src/platform/platform-services.js` | `MacOSPlatformServices` | Protected path guards, `lstat`/`realpath` symlink boundaries, physical inode (`dev:ino`) keys, Finder reveal |
| **ApplicationDiscovery** | `src/discovery/application-discovery.js` | `MacOSApplicationDiscovery` | Passive `Contents/Info.plist` parsing without executing `.app` binaries |
| **AdapterRegistry** | `src/adapters/adapter-registry.js` | `MacOSApplicationDiscovery` | Pluggable adapters for **Claude Code**, **Cursor**, **Codex CLI**, and **Generic macOS Apps** |
| **Scanner** | `src/scanner/scanner.js` | `ArtifactAtlasCore` | Cancellable, permission-aware walker with symlink boundary enforcement |
| **ArtifactIndexer** | `src/indexer/artifact-indexer.js` | `ArtifactAtlasCore` | Normalizes filesystem metadata and deduplicates physical hardlinks |
| **ProvenanceEngine** | `src/provenance/provenance-engine.js` | `ArtifactAtlasCore` | Builds `VERIFIED`, `INFERRED`, and `UNKNOWN` provenance edges and multi-session `SHARED_WITH` links |
| **ClassificationEngine** | `src/classification/classification-engine.js` | `MacOSArtifactClassifier` | Classifies 10 artifact types and 4 risk categories (`LOW`, `REVIEW`, `HIGH`, `PROTECTED`) |
| **GraphEngine** | `src/graph/graph-engine.js` | `ArtifactAtlasCore` | Constructs 7-node-type, 8-edge-type Knowledge Graph, path tracer, and deduplicated Space Treemap |
| **CleanupEngine** | `src/cleanup/cleanup-engine.js` | `ArtifactAtlasCore` | 10-step pre-flight validator, Quarantine Vault mover, `manifest.json` writer, and conflict-safe restore |
| **Persistence** | `src/persistence/sqlite-store.js` | `SQLite3` | Transactional SQLite persistence with numbered schema migrations (`schema_migrations`) |
| **DesktopUI** | `src/ui/` (`server.js` + `public/`) | `Sources/ArtifactAtlasApp/` | Empty dropzone, interactive Knowledge Graph canvas, Space Treemap, Provenance Inspector, Quarantine Vault |

---

## macOS Permissions & Filesystem Boundaries

- **Least-Privilege Access**: Artifact Atlas does **not** require Full Disk Access by default. It scans only known application support/cache/log locations (`~/Library/Application Support/<App>`, `~/Library/Caches/<BundleID>`, `~/Library/Logs/<App>`, `~/.claude`, `~/.cursor`, `~/.codex`) and user-authorized project workspaces.
- **Protected System & Credential Denylist**: `/System`, `/bin`, `/sbin`, `/usr`, `/etc`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/Library/Keychains`, and `.git` object stores are strictly protected from cleanup.
- **Symlink Escape Prevention**: Every directory and file is inspected with `lstat` (not `stat`). Symlinks pointing outside authorized scan boundaries are skipped and recorded in scan diagnostics.
- **Physical Hardlink Deduplication**: Files sharing the same physical device and inode (`${dev}:${ino}`) are flagged with shared dependency warnings and counted only once in physical byte totals.

---

## Documentation Links

- [System Architecture (`ARCHITECTURE.md`)](file:///home/antigravity/yazicmert/basket/ARCHITECTURE.md)
- [Product & Engineering Roadmap (`ROADMAP.md`)](file:///home/antigravity/yazicmert/basket/ROADMAP.md)
- [Agent Safety Guidelines (`AGENTS.md`)](file:///home/antigravity/yazicmert/basket/AGENTS.md)
# AGENTS.md — Guidelines for AI Coding Agents Working in `basket` (Artifact Atlas)

## 1. Repository Mission & Non-Negotiable Safety Rules

**Artifact Atlas** is a safety-critical local filesystem provenance and cleanup tool. Any agent modifying this codebase must uphold these invariants:

1. **Never Execute Scanned Applications**: `.app` bundles dropped or selected by the user must only be inspected via static metadata (`Contents/Info.plist`, directory structure). Never spawn or execute binaries inside scanned bundles.
   - The same holds on Windows: a program, shortcut (`.lnk`) or installation folder is identified by its name and the target path stored in the shortcut; a Microsoft Store app by the name of its data folder under `AppData\Local\Packages`. A program's icon is read from the icon resources of its `.exe` file (`src/discovery/windows-icon.js`). No program is started and no registry tool is run. Besides its own backend, the app starts only Windows' own tools on Windows: the file dialogs (`src/platform/windows-picker.js`, Windows PowerShell; they return the path the user picked), File Explorer to show a file or open the download page, `tar.exe` to unpack an update, and the Windows PowerShell update helper.
2. **Never Delete a User File Without the Quarantine First**: All cleanup operations in `CleanupEngine` must move files into the managed Quarantine Vault with both a SQLite record and an on-disk `manifest.json` recovery descriptor.
   - The only permanent deletion is emptying the Quarantine (`CleanupEngine.purgeEntries`), and only for files that have waited there at least `PURGE_MIN_AGE_DAYS` (30). The user sees the exact list first and confirms it; the confirmation is bound to that list, used once and expires after ten minutes. Each payload is checked again just before: the path comes from the vault layout (never a stored path), `lstat` must say regular file, `realpath` must be inside the vault, and the date in SQLite and in the manifest must agree. The manifest and the row stay, marked `PURGED`. Never add a way to empty the Quarantine without waiting, or anything else that deletes.
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
   - One exception is for display only: `src/provenance/session-prompt.js` reads the first prompt of a session from its transcript when the user selects a node (`/api/node/prompt`) and when a map level with session marks is served (`/api/map/level`, where it labels sessions whose title was made up from their ID). The text is put on that response only and goes to the local window and nowhere else: never into the session model, SQLite, the scan state, a log or a file. Only transcripts inside the folders of the active scan are read. Do not add other readers of conversation text, and do not cache this one.
   - A session's transcript is its main file (`<session>.jsonl`), not a subagent's (`<session>/subagents/*.jsonl`), whose records carry the parent's session ID.
   - `src/graph/prompt-costs.js` measures what each session left behind (output in projects, scratch written elsewhere, files kept by the app for it, its record) as numbers only. Present them as lower bounds: files made by commands a session ran are not in its record. "Select what it left behind" never includes the session's record (it is the link to the prompt), its output in projects, protected files, files shared with another session, or anything of a session that changed in the last hour or has no date. Every selected file still goes through the cleanup review, and the review itself (`ArtifactAtlasService.prepareCleanupReview`) blocks the files of a possibly running session however they were selected; bulk rules follow the size of the user's selection.

7. **Never Scan the Real Home Folder Without Consent**:
   - The UI server serves sandbox sample data until the user grants the `home-folder-scan` consent; the consent is persisted and revocable. Probing permission status must never trigger a macOS prompt or read file contents.
   - Permissions are asked when a scan of a real application starts (the pre-scan questions in the Permissions window) and stay changeable there. What a scan counts is a permission too (`SCAN_SCOPE`: `project-folders`, `dependency-folders`); both are off until the user turns them on. A project folder is walked in full only with `project-folders`, and never when it is the home folder, a folder containing it, a drive root or a protected path. With `dependency-folders`, dependency and Git folders inside project folders are measured as a whole (`scan.bulkFolders`): counted and sized, never listed as artifacts, never selectable and never cleaned up. Without it they are not read.
   - Past the file limit, files are measured (`scan.overflow`) but not listed, so the total stays complete. They are totalled by folder (`scan.overflow.folders`, the walk root plus up to three folders) so the map can show where they are; they are never selectable. Listed bytes (`scan.totalPhysicalBytes`) and measured bytes (`scan.measuredPhysicalBytes`) are kept apart; a hardlinked file is counted once across both.

8. **Network Use Is Limited to Updates**:
   - The app's only outbound requests are the new-version check in `src/platform/update-check.js` (GitHub's latest-release endpoint) and, only after the user clicks the update button, the download of that release in `src/platform/self-update.js`. No request may carry user, machine or file data. The check stays switchable in Settings. Do not add other network calls.
   - The check runs while the app is open (the backend asks GitHub at most once every half hour), so a new version shows up without a restart.
   - A copy that cannot be replaced where it is (opened from the disk image, translocated, or in a folder the user cannot write to) is installed into the Applications folder, or the user's own Applications folder, and the confirmation says so. The download page is opened only when nothing can be installed from the app, after saying why. An update that did not finish is reported on the next launch with the helper's reason.
   - On Windows an update is installed in place too (`src/platform/self-update-windows.js`): the ZIP must match the published SHA-256, is unpacked with the system `tar.exe`, and must hold `ArtifactAtlas.exe`, its runtime and an `app/package.json` named `artifact-atlas` with the expected version. There is no code signature to check, so those checks stand in for it. The Windows PowerShell helper replaces only the app's own entries, keeps the previous ones until the new copy is in place and restores them on failure; a folder the user cannot write to is replaced by an install in `%LOCALAPPDATA%\Programs\ArtifactAtlas`.
   - An update is installed only when its ZIP matches the SHA-256 published with the release, the unpacked bundle has this app's bundle identifier and the expected version, and `codesign --verify` passes. The swap keeps the previous bundle until the new one is in place and restores it on failure. Never install silently.

## 2. Project Layout

- `src/` — Portable Core & Local Desktop Application (Node.js 24 ESM + built-in `node:sqlite`):
  - `src/models/` — Versioned domain models and enumerations.
  - `src/platform/` — `PlatformServices` (filesystem boundary guards, symlink checks, inode identity, Finder / File Explorer reveal, macOS Library and Windows AppData locations). `platform` names the layout of the home folder being read (`darwin` or `win32`); the sample home is always laid out like a Mac's.
  - `src/platform/path-keys.js` — `/`-separated keys for Windows paths, used only for matching and folder grouping. Never pass a key to the filesystem.
  - `src/discovery/windows-apps.js` — Windows applications: Start Menu shortcuts by name and the shortcut's stored target, and Store apps by their `Packages` folder name.
  - `src/discovery/windows-icon.js` — A program's icon, read from the resources of its `.exe` (PE file); static read only.
  - `src/platform/windows-picker.js` — The Windows file and folder dialogs behind Browse in Choose App.
  - `src/platform/self-update-windows.js` — In-place update on Windows (see rule 8).
  - `src/provenance/session-prompt.js` — First prompt of a session, read on demand for display (see rule 6).
  - `src/platform/permissions.js` — Permission model (in-app home-folder-scan consent, macOS Full Disk Access probe, allowlisted System Settings / documentation targets). Every permission id must have a page under `site/permissions/<id>/`.
  - `src/discovery/` — `ApplicationDiscovery` (`.app/Contents/Info.plist` XML/binary parser and app identity resolver) and `app-footprint.js` (generic per-app data location discovery by bundle identifier and name; strict matching only, attribution stays `INFERRED`).
  - `src/discovery/app-icon.js` — Copies an application's own icon (PNG inside `Contents/Resources/*.icns`) out of its bundle for display. Static read only; the icon must be a regular file inside the bundle, and the UI server serves it only for bundles already listed in the picker.
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
  - `src/ui/public/icons.js` — Shared icon set (one glyph per artifact type, plus workspace, session, tool call and application fallbacks). `site/icons.js` must stay an exact copy; a test enforces it. Glyphs are original and are not product logos. Color stays reserved for cleanup risk. Known applications may fall back to a logo from `src/ui/public/logos/` (Simple Icons, trademarks of their owners; see the README there) when their own icon cannot be read.
  - `src/graph/project-leftovers.js` — Worktrees (a `.git` file, or `.claude/worktrees/<name>`) and build outputs by project. Only what files state: Git metadata files are read (never `git` run) and only with `dependency-folders`; whether a branch was merged or has uncommitted work is never claimed. A worktree is never moved as a whole; its build outputs go through the review, and the Git command that removes it is shown for the user to run.
  - `src/graph/scan-history.js` — A summary of numbers after each scan (totals, by kind, by session ID) in `scan_history`, and the change since the newest earlier scan of the same app that counted the same things. Different scan permissions, a file limit or a cancelled scan mean no change is claimed. Never conversation text.
  - `src/graph/identical-files.js` — Files with identical content, only when the user asks: same size, different inode, prefix hash then full hash, read in pieces that yield and can be cancelled. Reported as identical content, not as space to reclaim. "Select all but one" keeps a protected or project copy, else the oldest, and never selects a protected copy.
  - `src/graph/report.js` — The report (a page and a CSV) written to the data folder's `reports/` when the user asks. Numbers, paths and session titles; a title made up from an ID shows the ID. No prompt text. CSV cells that would run as formulas are written as text.
  - `src/discovery/diagnostics.js` — Text the user can copy from Settings: the largest unclassified folders, and the shape of Cursor's and Codex's records (field names and value types; IDs and paths become placeholders; Cursor's database is opened read-only). Made on request, never sent.
  - `src/graph/reveal-target.js` — What Show in Finder / File Explorer opens for a selection: the file, the folder it shares, or a list of the folders it is spread over (never the home folder or a drive root). The server opens places by an index or id from lists it worked out, never by a path the window sends.
  - `src/graph/map-levels.js` — The map is served one level at a time (`/api/map/level`): the app with its kinds and sessions, then folders, then files, with alternative top-level groupings. No level may hold more than a few dozen marks.
  - `src/cli.js` — Command-line entrypoint (`serve`, `scan`, `demo`, `quarantine`, `restore`).
- `packaging/windows/` — Windows launcher (`Launcher.cs`, compiled with the C# compiler that ships with Windows; keep it to C# 5), icon and README. `scripts/package-windows.ps1` builds `dist/ArtifactAtlas-Windows.zip`; `scripts/verify-windows-bundle.ps1` checks it, `scripts/test-self-update-windows.ps1` checks the update swap under Windows PowerShell 5.1, and `scripts/test-windows-launch.ps1` starts the app as a user would and checks the readers against the machine's real Start Menu and Store folders.
- `Sources/` & `Tests/` — Native macOS Swift Package (`ArtifactAtlasCore`, `ArtifactAtlasApp`, `ArtifactAtlasCoreTests`).
- `site/` — Project site published to GitHub Pages (landing page and one page per permission).
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
- **Build & verify the Windows ZIP (requires Windows 10 or 11; no extra tools)**:
  ```powershell
  ./scripts/package-windows.ps1
  ./scripts/verify-windows-bundle.ps1
  ```
- Tests run on Linux, macOS and Windows in CI. Build paths with `path.join`, compare with `path.sep`, and close a service's database before removing its folder (Windows cannot delete an open file).

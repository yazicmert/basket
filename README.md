# Artifact Atlas — AI Artifact Provenance & Cleanup Explorer

> **Know what created a file, why it exists, whether it is still needed, and what happens if it is removed.**

**Artifact Atlas** is a local-first, privacy-preserving macOS desktop application that discovers, traces, visualizes, and safely manages filesystem artifacts associated with AI applications and AI-assisted development workflows (`Claude Code`, `Claude Desktop`, `Cursor`, `Codex CLI`, and generic macOS `.app` bundles).

---

## Installing the Standalone macOS Application (`.dmg` / `.zip`)

The packaged `ArtifactAtlas.app` is **100% self-contained** and runs completely offline. It bundles the compiled native macOS SwiftUI + WebKit executable (`Contents/MacOS/ArtifactAtlasApp`), the standalone Node.js runtime (`Contents/Resources/runtime/node` with built-in SQLite), the custom `AppIcon.icns`, and all analysis and UI modules (`Contents/Resources/app/`). **Users do not need to install Node.js, Swift, Xcode, npm, or run terminal commands.**

### Installation from `ArtifactAtlas-macOS.dmg`
1. Download `ArtifactAtlas-macOS.dmg` (and optional `SHA256SUMS.txt` to verify checksum integrity via `shasum -a 256 -c SHA256SUMS.txt`).
2. Double-click `ArtifactAtlas-macOS.dmg` to mount the **Artifact Atlas** disk image.
3. Drag **`ArtifactAtlas.app`** into the **`Applications`** folder shortcut.
4. Launch **Artifact Atlas** from `/Applications` or Spotlight.

### Installation on Windows from `ArtifactAtlas-Windows.zip`
1. Download `ArtifactAtlas-Windows.zip` (Windows 10 or 11, 64-bit) and extract it.
2. Start `ArtifactAtlas.exe` from the extracted `ArtifactAtlas` folder. The build is not signed with a certificate, so Windows shows *Windows protected your PC*: choose **More info**, then **Run anyway**.
3. The app opens in a window of its own (drawn by Microsoft Edge or Chrome with a separate profile). Closing the window quits it.

Nothing is installed and no administrator rights are needed. The folder holds the launcher, its own Node.js runtime and the app's source. Settings, the index and the Quarantine Vault are kept in `%LOCALAPPDATA%\ArtifactAtlas`. On Windows, applications are listed from the Start Menu, and their data is located by name in `AppData\Roaming`, `AppData\Local` and hidden home folders.

### First Launch: Sample Data, Then Your Real Files
Artifact Atlas starts on built-in sample data and reads nothing from your disk. When you choose a real application, it asks for what the scan needs before reading anything; the **Permissions** window shows the same list afterwards, and each permission has its own page:

| Permission | Type | Page |
|---|---|---|
| Scan my home folder | In-app consent, required for real scans | [home-folder-scan](https://yazicmert.github.io/basket/permissions/home-folder-scan/) |
| Full Disk Access | macOS setting, recommended | [full-disk-access](https://yazicmert.github.io/basket/permissions/full-disk-access/) |
| Data from other apps | macOS prompt, asked when needed | [app-data](https://yazicmert.github.io/basket/permissions/app-data/) |
| Desktop, Documents and Downloads | macOS prompt, asked when needed | [files-and-folders](https://yazicmert.github.io/basket/permissions/files-and-folders/) |
| Whole project folders | What a scan counts, off by default | [project-folders](https://yazicmert.github.io/basket/permissions/project-folders/) |
| Dependency and Git folders | What a scan counts, off by default | [dependency-folders](https://yazicmert.github.io/basket/permissions/dependency-folders/) |

**Why two scans can show different totals.** By default a scan counts the application's own folders, plus only the files its sessions' tool calls named inside your project folders. With *Whole project folders* included, every file in those project folders is counted, which can double the total. The details panel says how the current scan was counted, and how many items could not be read.

**Starting prompt.** Selecting a session, a tool call or a file shows the first prompt of the session behind it. It is read from the session's own record at that moment and is not stored by Artifact Atlas.

After you allow home folder scanning, drop any `.app` onto the window. Its data is located by bundle identifier and name across `~/Library` containers, sandbox containers, and hidden home folders (`~/.claude`, `~/.ollama`, `~/.config/<app>`, …), and the folder being scanned is shown live. Claude Code, Cursor and Codex CLI additionally get session-level provenance; for every other application, files are attributed to the application (`INFERRED`), not to a conversation.

### macOS Gatekeeper Notice for Ad-Hoc Signed / Unsigned Builds
When `ArtifactAtlas-macOS.dmg` or `ArtifactAtlas-macOS.zip` is built without an Apple Developer ID certificate and Apple Notarization credentials (`APPLE_DEVELOPER_ID_APPLICATION`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`), the packaging script applies an **ad-hoc code signature** (`codesign --sign -`).

Because ad-hoc signed builds are not notarized by Apple, **macOS Gatekeeper** will display an *"ArtifactAtlas.app cannot be opened because the developer cannot be verified"* or *"is damaged / from an unidentified developer"* prompt when downloaded from a web browser (which attaches the `com.apple.quarantine` extended attribute).

To open an ad-hoc signed build on macOS:
1. **Via Finder / System Settings**:
   - Open the app once and dismiss the warning, then open **System Settings → Privacy & Security**, scroll down to the Security section, and click **Open Anyway** next to `ArtifactAtlas.app`.
   - On macOS 14 you can instead **Control-click** `ArtifactAtlas.app` in `/Applications` and select **Open**. macOS 15 and later no longer offer this.
2. **Or remove the browser download quarantine flag**:
   ```bash
   xattr -dr com.apple.quarantine /Applications/ArtifactAtlas.app
   ```

---

## Core Principles & Safety Guarantees

1. **100% Local-First & Offline**: No cloud accounts, no telemetry, no external AI APIs, and zero uploading of conversation histories or file contents.
2. **Loopback-Only & Token-Protected Local Engine**: When `ArtifactAtlas.app` launches, [`BackendProcessManager`](file:///home/antigravity/yazicmert/basket/Sources/ArtifactAtlasCore/Services/BackendProcessManager.swift) spawns the bundled runtime bound strictly to `127.0.0.1` (`loopback`) on an ephemeral port, protected by a per-session 256-bit `X-Atlas-Token`, `SameSite=Strict` cookie, and `Host`/`Origin` CSRF guards. Closing the app immediately terminates the child process (`--watch-stdin` + `--parent-pid` + `SIGTERM`).
3. **Passive Application Identification**: Dropped `.app` bundles are identified strictly via static bundle metadata (`Contents/Info.plist`) and are **never executed**.
4. **Epistemic Honesty in Provenance**:
   - **`VERIFIED`**: Backed by a direct tool-invocation record in an authoritative session transcript or composer ledger (`Write`, `Edit`, `MultiEdit`, `apply_patch`), or the authoritative transcript file itself.
   - **`INFERRED`**: Backed by indirect structural evidence (e.g., dedicated application cache/log container, session ID embedded in path, or build output derived from a verified source file).
   - **`UNKNOWN`**: Unattributed files are explicitly linked to an `UNKNOWN_ORIGIN` node. **Timestamp proximity alone never fabricates a conversation-to-file link.**
5. **Multi-Factor Risk Classification**: Filename extension alone (e.g., `.tmp` or `.log`) never grants `LOW` deletion risk. The classifier evaluates canonical directory context, Git repository proximity, provenance confidence, physical hardlinks, and multi-session sharing.
6. **Recoverable Quarantine over Permanent Deletion**: Selecting **Delete (Move to Quarantine)** runs a 10-step pre-flight verification (re-checking inode identity, file size, modification timestamp, permissions, and symlink traversal) and moves eligible files into a managed Quarantine Vault (`~/Library/Application Support/ArtifactAtlas/live/quarantine-vault` for real scans) with both a SQLite record and an on-disk `manifest.json` recovery file. The manifest is written before the file moves, every payload carries a SHA-256 digest, and restoring with **Replace** moves the file currently at the destination into the vault instead of overwriting it.

---

## Reproducible macOS Packaging & Verification

### Build `ArtifactAtlas.app`, `.dmg`, `.zip`, and `SHA256SUMS.txt` on macOS
On a macOS 14+ host (`arm64` by default, or set `TARGET_ARCH=x86_64` / `TARGET_ARCH=universal`):

```bash
# Build, code-sign, run --verify-workflow, and package DMG + ZIP + SHA256SUMS.txt:
npm run package:macos

# Mount the DMG read-only and run full end-to-end verification from the mounted volume:
npm run verify:macos
```

Outputs are written to `dist/`:
- `dist/ArtifactAtlas.app` (Bundle ID: `com.artifactatlas.desktop`, Version: `0.6.2`, Min macOS: `14.0`)
- `dist/ArtifactAtlas-macOS.dmg` (Compressed UDZO disk image with `/Applications` drag-install link)
- `dist/ArtifactAtlas-macOS.zip` (`ditto` archive preserving bundle signatures and permissions)
- `dist/SHA256SUMS.txt` (SHA-256 digests for release artifacts)

### Optional Developer ID Signing & Apple Notarization
When the following environment variables (or GitHub Actions Secrets) are provided, [`scripts/package-macos.sh`](file:///home/antigravity/yazicmert/basket/scripts/package-macos.sh) automatically signs with Hardened Runtime (`--options runtime`) using [`packaging/entitlements.plist`](file:///home/antigravity/yazicmert/basket/packaging/entitlements.plist) and notarizes/staples the DMG:
- `APPLE_DEVELOPER_ID_APPLICATION` (e.g., `"Developer ID Application: Your Name (TEAMID)"`)
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`

On GitHub Actions only the manual release workflow signs. It also needs the certificate itself, imported into a temporary keychain from two more secrets:
- `APPLE_CERTIFICATE_P12_BASE64` (the Developer ID Application certificate with its private key, exported as `.p12` and base64-encoded)
- `APPLE_CERTIFICATE_PASSWORD` (the password chosen when exporting the `.p12`)

Without the certificate secrets the release is ad-hoc signed. Continuous builds are always ad-hoc signed and never receive these secrets.

### GitHub Actions Workflows
- **Continuous macOS Build & Artifact Upload**: [`.github/workflows/macos-build.yml`](file:///home/antigravity/yazicmert/basket/.github/workflows/macos-build.yml) runs on `macos-14` (`arm64`), executes `npm test` and `swift test`, runs `scripts/package-macos.sh` and `scripts/verify-macos-bundle.sh`, and uploads `ArtifactAtlas-macOS.dmg`, `ArtifactAtlas-macOS.zip`, and `SHA256SUMS.txt` as downloadable workflow artifacts.
- **Explicit Manual Release Publishing**: [`.github/workflows/macos-release.yml`](file:///home/antigravity/yazicmert/basket/.github/workflows/macos-release.yml) uses `workflow_dispatch` (manual trigger only) to publish verified builds to GitHub Releases.

---

## Developer Quick Start (Portable Core & CLI)

```bash
# 1. Run all unit, security, and child-process lifecycle tests
npm test

# 2. Run the end-to-end vertical slice CLI demonstration
npm run demo

# 3. Launch the local loopback server directly
npm start

# 4. Run native macOS Swift XCTests (on macOS 14+)
swift test
```

Requires Node.js 22.13 or newer (built-in `node:sqlite`).

### Quarantine & Restore from the CLI

Both commands use a persistent index and vault (`~/.artifact-atlas` by default, or `--data-dir <dir>`).

```bash
# Step 1: review only. Prints the classification, warnings, and a confirmation token; nothing moves.
node src/cli.js quarantine ~/Library/Caches/com.example.app/blob.bin --app /Applications/Example.app

# Step 2: re-run with the printed token to move the file into the Quarantine Vault.
node src/cli.js quarantine ~/Library/Caches/com.example.app/blob.bin --app /Applications/Example.app --confirm confirm_<token>

# List vault entries and restore one (FAIL_IF_EXISTS | RENAME_RESTORED | OVERWRITE_IF_EXPLICIT).
node src/cli.js restore --list
node src/cli.js restore qent_<id> --strategy FAIL_IF_EXISTS
```

Files with `UNKNOWN` provenance or `HIGH` risk additionally need `--allow-high-risk`, one file at a time. `--workspace <dir>` sets the scan root (defaults to the file's parent directory).

---

## Documentation Links

- [System Architecture (`ARCHITECTURE.md`)](file:///home/antigravity/yazicmert/basket/ARCHITECTURE.md)
- [Product & Engineering Roadmap (`ROADMAP.md`)](file:///home/antigravity/yazicmert/basket/ROADMAP.md)
- [Agent Safety Guidelines (`AGENTS.md`)](file:///home/antigravity/yazicmert/basket/AGENTS.md)
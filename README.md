# Artifact Atlas

> **Know which AI session made a file before you delete it.**

Artifact Atlas shows what an application left on your Mac or PC: caches, logs, models, session records and the files its AI sessions wrote. It links each file to the session and tool call that produced it where a record exists, says how safe it is to remove, and moves what you choose into a Quarantine you can restore from. Nothing is deleted permanently, nothing leaves your computer, and the applications you scan are never started.

Session-level tracing works for **Claude Code** (the CLI, and the Code view of the Claude app): each file a session wrote is linked to the session and the tool call that wrote it. For **Cursor** and **Codex** (the CLI, and the Codex view of the ChatGPT desktop app, which replaced the separate Codex app in July 2026) sessions are listed with their starting prompt, but linking their files to tool calls is not yet supported for their current record formats. Any other application can be scanned too; its files are attributed to the application, not to a session. Windsurf, renamed Devin Desktop, is found under both names.

**Website:** [yazicmert.github.io/basket](https://yazicmert.github.io/basket/) · **Downloads:** [latest release](https://github.com/yazicmert/basket/releases/latest)

---

## Install

### macOS (14 or later, Apple silicon)

1. Download [`ArtifactAtlas-macOS.dmg`](https://github.com/yazicmert/basket/releases/latest/download/ArtifactAtlas-macOS.dmg) and open it.
2. Drag **ArtifactAtlas.app** into **Applications**.
3. Open it once. Current builds are not notarized by Apple, so macOS blocks the first launch: click **Done**, open **System Settings → Privacy & Security**, and click **Open Anyway** next to ArtifactAtlas. You can instead clear the download flag:

   ```bash
   xattr -dr com.apple.quarantine /Applications/ArtifactAtlas.app
   ```

The app carries its own Node.js runtime; nothing else needs to be installed. Settings, the index and the Quarantine are kept in `~/Library/Application Support/ArtifactAtlas`.

### Windows (10 or 11, 64-bit)

1. Download [`ArtifactAtlas-Windows.zip`](https://github.com/yazicmert/basket/releases/latest/download/ArtifactAtlas-Windows.zip) and extract it.
2. Start **ArtifactAtlas.exe** from the extracted `ArtifactAtlas` folder. The build is not signed with a certificate, so Windows shows *Windows protected your PC*: click **More info**, then **Run anyway**.

Nothing is installed and no administrator rights are needed. The window is drawn by Microsoft Edge (or Chrome) with a separate profile; closing it quits the app. Settings, the index and the Quarantine are kept in `%LOCALAPPDATA%\ArtifactAtlas`.

### Check a download

Every release publishes `SHA256SUMS.txt` with the SHA-256 of each file.

```bash
shasum -a 256 ~/Downloads/ArtifactAtlas-macOS.dmg
```

```powershell
Get-FileHash $HOME\Downloads\ArtifactAtlas-Windows.zip -Algorithm SHA256
```

### Updates

While the app is open it checks GitHub for a newer release at most once every half hour. On macOS, one confirmation downloads the new version, checks it against its published SHA-256, its bundle identifier, its version and its code signature, and restarts into it. A copy opened from the disk image is installed into Applications. If an update cannot finish, the previous version is kept and the app says why on its next launch. On Windows the update button opens the download page. The check can be turned off in **Settings**.

---

## Using it

1. The app opens on built-in sample data and reads nothing from your disk.
2. Choose an application: drag it from Applications onto the window on macOS, or pick it from the list. Known AI tools that are not installed as an app but left data behind (command-line tools such as Claude Code, or apps you removed) are listed apart, under *Not installed, data found*, with the folder that was found. An empty folder does not count.
3. Before the first real scan, the app asks what it may read and what it should count (see [Permissions](#permissions)). The folder being scanned is shown live.
4. The **Map** opens level by level: the application with its kinds of files and its sessions, then folders, then files. **Sizes** shows the same files as a treemap; **Quarantine** lists what you moved.
5. Select files and choose **Move to Quarantine…**. A review lists what can move and what is blocked, and why. Restoring never overwrites another file.

### What the map shows

- **Sessions** are labelled by the prompt that started them. Selecting a session, a tool call or a file shows that prompt in full in the details panel. It is read from the session's own record each time it is shown and is not stored.
- **What a prompt cost.** Selecting a session shows what it left behind beyond its output: files it wrote outside your projects (screenshots, tests, scripts), files the app keeps for it (tool results, subagent files, todo lists, logs) and its own record, each with a file count and size. Sessions are ordered by this cost. These are lower bounds, because files made by commands a session ran (installs, builds) are not named in its record. **Select What It Left Behind** selects only that session's leftovers: never its output, its record, files shared with another session, or anything of a session that may still be running. Every file is reviewed before it moves.
- **Search** and the risk and origin filters look through every listed file, not only the marks of the open level. The largest matches are listed in the details panel, and all matches can be selected for review.
- **Files of a session that may still be running** (changed in the last hour, or with no date) are never moved, however they were selected; the review says why.
- **Traced to a prompt** in the details panel splits the scan into files that come from a session, files that belong to the app as a whole (caches, updates, plug-ins) and your own project files.
- **Kinds** (caches, logs, build outputs, session histories, model data, your own files, …) show their size, file count, cleanup risk and, when opened, their largest file types.
- **Dependencies & Git (measured)** appears when dependency folders are included: `node_modules`, `.git`, virtual environments and similar folders inside project folders, counted and sized as a whole, never listed file by file and never offered for cleanup.
- Colour is used only for cleanup risk: **safe to remove**, **review first**, **high risk**, **protected**. Line style shows how an origin is known: **recorded** by a session, **likely** from the application, or **unknown**.

### Why two scans can show different totals

- **What is counted in project folders.** By default a scan counts the application's own folders, plus only the files its sessions' tool calls named inside your project folders. With *Whole project folders* included, every file in those folders is counted, which can double the total.
- **Dependency and Git folders.** Left out by default. When included, they are measured and added to the total.
- **The file limit.** A scan lists up to 300,000 files. Files past the limit are still measured, so the total stays complete, but they are not on the map and cannot be selected.
- **Folders that could not be read.** The notice above the map names them; on macOS, Full Disk Access usually fixes this.

The details panel shows each part separately: the application's own folders, project folders, measured dependency folders and files past the limit.

---

## Permissions

Each permission is asked inside the app before the first real scan and can be changed later in the **Permissions** window. Each has its own page.

| Permission | What it is | Page |
|---|---|---|
| Scan my home folder | In-app consent, required for real scans | [home-folder-scan](https://yazicmert.github.io/basket/permissions/home-folder-scan/) |
| Whole project folders | What a scan counts; off by default | [project-folders](https://yazicmert.github.io/basket/permissions/project-folders/) |
| Dependency and Git folders | What a scan counts; off by default | [dependency-folders](https://yazicmert.github.io/basket/permissions/dependency-folders/) |
| Full Disk Access | macOS setting, recommended | [full-disk-access](https://yazicmert.github.io/basket/permissions/full-disk-access/) |
| Data from other apps | macOS prompt, asked when needed | [app-data](https://yazicmert.github.io/basket/permissions/app-data/) |
| Desktop, Documents and Downloads | macOS prompt, asked when needed | [files-and-folders](https://yazicmert.github.io/basket/permissions/files-and-folders/) |

The three macOS settings do not exist on Windows.

---

## Safety guarantees

1. **Local only.** No account, no telemetry, no upload. The only network use is the update check and, when you click the button, the update download. Neither sends anything about you or your files.
2. **Reads, never runs.** On macOS an application is identified from its `Contents/Info.plist`; on Windows from its shortcut or program name and the target stored in the shortcut. Scanned applications are never executed. Symlinks are never followed outside the folders being scanned, and credential and system folders are never read.
3. **Honest provenance.**
   - `VERIFIED`: a session's record names the file in a tool call (`Write`, `Edit`, `apply_patch`, …), or the file is the record itself.
   - `INFERRED`: structural evidence, such as the application's own cache or log folder.
   - `UNKNOWN`: no evidence. Timestamp proximity alone never links a file to a session.
4. **Risk is never judged by extension alone.** The classifier looks at the folder a file is in, Git repositories, provenance, hardlinks and files shared between sessions. Source code, Git data, session records, model weights, credentials and files in your project folders that no session recorded are never marked safe to remove.
5. **Quarantine, not deletion.** Moving a file runs a pre-flight check (same file, same size and time, inside the scanned folders, not a symlink), writes a recovery manifest before the move, and keeps a SHA-256 of every file. Sizes count hardlinked data once.
6. **No conversation text is stored.** The index holds session IDs, timestamps, tool names and file paths. The starting prompt shown in the window is read from the session's record when it is shown and is never written anywhere.
7. **Loopback only.** The app's interface talks to a backend bound to `127.0.0.1` on a random port, protected by a per-launch token and `Host` and `Origin` checks. The backend stops when the app quits.

---

## Run from source

Requires Node.js 22.13 or newer (built-in `node:sqlite`). There are no npm dependencies.

```bash
git clone https://github.com/yazicmert/basket.git
cd basket
npm start        # opens the interface on http://127.0.0.1:4310
```

```bash
npm test         # the test suite (runs on Linux, macOS and Windows)
npm run demo     # an end-to-end run on sample data in the terminal
```

### Quarantine and restore from the command line

Both commands use a persistent index and Quarantine (`~/.artifact-atlas` by default, or `--data-dir <dir>`).

```bash
# Review only: prints the classification, warnings and a confirmation token. Nothing moves.
node src/cli.js quarantine ~/Library/Caches/com.example.app/blob.bin --app /Applications/Example.app
```

```bash
# Move it, with the printed token
node src/cli.js quarantine ~/Library/Caches/com.example.app/blob.bin --app /Applications/Example.app --confirm confirm_<token>
```

```bash
# List the Quarantine and restore an entry (FAIL_IF_EXISTS | RENAME_RESTORED | OVERWRITE_IF_EXPLICIT)
node src/cli.js restore --list
node src/cli.js restore qent_<id> --strategy FAIL_IF_EXISTS
```

Files with `UNKNOWN` provenance or `HIGH` risk also need `--allow-high-risk`, one file at a time.

---

## Building the apps

### macOS

On macOS 14 or later with Xcode (Swift 5.10+):

```bash
swift test
npm run package:macos   # builds, signs and checks dist/ArtifactAtlas.app, the DMG, the ZIP and SHA256SUMS.txt
npm run verify:macos    # mounts the DMG read-only and runs the end-to-end check from it
```

Builds are ad-hoc signed. With `APPLE_DEVELOPER_ID_APPLICATION`, `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_SPECIFIC_PASSWORD` set, `scripts/package-macos.sh` signs with the Hardened Runtime and notarizes the DMG. In the release workflow the certificate comes from the `APPLE_CERTIFICATE_P12_BASE64` and `APPLE_CERTIFICATE_PASSWORD` secrets; without them the release is ad-hoc signed.

### Windows

On Windows 10 or 11, with nothing extra installed:

```powershell
./scripts/package-windows.ps1        # downloads and checks the Node.js runtime, compiles ArtifactAtlas.exe, writes the ZIP and its SHA-256
./scripts/verify-windows-bundle.ps1  # extracts the ZIP, runs the end-to-end check and starts the launcher in test mode
```

### Continuous integration and releases

- [`macos-build.yml`](.github/workflows/macos-build.yml) (**Build, Test & Package**): runs the tests on Linux, builds and checks the Windows ZIP, and builds and checks the macOS app, DMG and in-place update, on pushes and pull requests to `main` and when started by hand.
- [`macos-release.yml`](.github/workflows/macos-release.yml) (**Publish Verified Release**): started by hand with a tag. Builds both platforms, checks them, and publishes the DMG, both ZIPs and one `SHA256SUMS.txt`.
- [`pages.yml`](.github/workflows/pages.yml): publishes `site/` to GitHub Pages.

---

## More

- [Architecture](ARCHITECTURE.md)
- [Roadmap](ROADMAP.md)
- [Rules for contributors and coding agents](AGENTS.md)
- [Permissions, one page each](https://yazicmert.github.io/basket/permissions/)

MIT licensed.

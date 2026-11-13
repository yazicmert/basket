Artifact Atlas for Windows
==========================

Start
  Double-click ArtifactAtlas.exe. Keep it in this folder: it needs the "runtime" and
  "app" folders next to it. You can move the whole folder anywhere and make a shortcut
  to ArtifactAtlas.exe.

First start
  Windows may show "Windows protected your PC" because this build is not signed with a
  paid certificate. Choose "More info", then "Run anyway". You can compare the ZIP file's
  SHA-256 with the one published on the release page first.

What it does
  Artifact Atlas shows what an application left on this PC (caches, logs, models, session
  files), which AI session created each file, and lets you move files to a Quarantine
  folder that you can restore from. Applications are read, never started. Nothing about
  you or your files leaves this PC; the only network use is the check for a new version,
  which you can turn off in Settings.

Window
  The interface opens in a window of its own using Microsoft Edge (or Chrome), with a
  separate profile kept in the app's data folder. Closing the window quits Artifact Atlas.

Data
  Settings, the index and the Quarantine folder are kept in
  %LOCALAPPDATA%\ArtifactAtlas. Deleting this program folder does not delete them.

More
  https://yazicmert.github.io/basket/

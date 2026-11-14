# Security

Artifact Atlas reads people's files and can move them, so security reports are welcome and taken seriously.

## Reporting a problem

Please report privately through [GitHub's security advisories](https://github.com/yazicmert/basket/security/advisories/new) rather than in a public issue. Include the version, the system, and the steps that show the problem. You will get an answer as soon as possible, and credit in the release notes if you would like it.

## What matters most

- Anything that makes the app read outside the folders it was allowed to, follow a link outside them, or start a program it scanned.
- Anything that moves or deletes a file without the Quarantine and the confirmations described in [AGENTS.md](AGENTS.md).
- Anything that lets another program or web page use the app's local interface.
- Anything that sends data off the computer, or installs an update that was not checked.

## Supported versions

Fixes go into the latest release. The app updates itself, so please update before reporting.

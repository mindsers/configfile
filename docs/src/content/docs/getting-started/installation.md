---
title: Installation
description: Install configfile on macOS or Linux, with one command, Homebrew or npm.
sidebar:
  order: 1
---

## Requirements

- macOS or Linux, on an Intel/AMD (x64) or ARM (arm64) processor
- git (when it is missing, *configfile* says how to install it on your system)

Installed with Homebrew or npm, *configfile* also needs Node.js 24.11 or later (Homebrew installs it for you). The standalone binary doesn't: it comes with its own, and needs macOS 13.5 or later, or Linux with the GNU C library 2.28 or later. Its install script needs `curl` or `wget`, which most systems have.

## Install

### With one command

On a new machine, this is the quickest way: no package manager and no Node.js needed.

```bash
curl -fsSL https://configfile.sh/install.sh | sh
```

The [script](https://github.com/mindsers/configfile/blob/master/docs/public/install.sh) downloads the standalone binary for your system from the [latest GitHub release](https://github.com/mindsers/configfile/releases/latest), checks it against the release's `SHA256SUMS`, and installs it as `~/.local/bin/configfile`, once it has checked that the binary starts on your system (a configfile already installed is otherwise left as it is). It says when that folder is not in your `PATH`, and how to add it. Two environment variables change what it does:

| Variable | Effect |
| --- | --- |
| `CONFIGFILE_VERSION` | the version to install, instead of the latest (releases have binaries from the one that introduced them; 1.0.0 has none) |
| `CONFIGFILE_INSTALL_DIR` | where to install it, instead of `~/.local/bin` |

```bash
# For every user of the machine (/usr/local/bin needs administrator rights).
curl -fsSL https://configfile.sh/install.sh | sudo CONFIGFILE_INSTALL_DIR=/usr/local/bin sh
```

Run the command again to update *configfile*, with the same `CONFIGFILE_INSTALL_DIR` if you set one (`configfile update` syncs your dotfiles, not *configfile* itself). To uninstall it, delete `~/.local/bin/configfile`; your configuration (`~/.configfilerc`, `~/.configfile/`) stays.

On Linux, the binaries need the GNU C library: on Alpine (musl), or a system older than the requirements above, install with npm. On macOS, a binary downloaded with a web browser is quarantined by Gatekeeper, as it is not notarized: use the install script, or run `xattr -d com.apple.quarantine configfile` on it.

The binary's own Node.js runs *configfile* only: a `.js` (`.mjs`, `.cjs`) [script](/reference/scripts/) without a shebang line runs with the `node` in your `PATH`, and fails with a message saying so when Node.js is not installed.

### With Homebrew

On macOS or Linux (Node.js and git come with it):

```bash
brew install mindsers/tap/configfile
```

### With npm

When Node.js 24.11 or later is installed, from the [GitHub release](https://github.com/mindsers/configfile/releases/latest):

```bash
npm install --global https://github.com/mindsers/configfile/releases/download/1.1.0/configfile-1.1.0.tgz
```

Install it one way only: two copies would compete in your `PATH`.

> Versions 1.x are not on the npm registry yet: `npm install --global configfile` still installs 0.3.1.

## Check a download

Each release comes with a `SHA256SUMS` file, which the install script uses, and a build provenance attestation for each archive (the `.tgz` package and every `.tar.gz` binary), which shows it was built by the project's release workflow from the tagged source. Download the archive, then:

```bash
gh attestation verify configfile-macos-arm64.tar.gz --repo mindsers/configfile
```

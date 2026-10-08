---
title: Installation
description: Install configfile on macOS or Linux, with Homebrew or npm.
sidebar:
  order: 1
---

## Requirements

- macOS or Linux
- Node.js 24.11 or later (Homebrew installs it for you)
- git (Homebrew installs it for you; otherwise, when it is missing, *configfile* says how to install it on your system)

## Install

With [Homebrew](https://brew.sh), on macOS or Linux (Node.js and git come with it):

```bash
brew install mindsers/tap/configfile
```

With npm, when Node.js 24.11 or later is installed, from the [GitHub release](https://github.com/mindsers/configfile/releases/latest):

```bash
npm install --global https://github.com/mindsers/configfile/releases/download/1.0.0/configfile-1.0.0.tgz
```

Install it one way only: two copies would compete in your `PATH`.

> Version 1.0 is not on the npm registry yet: `npm install --global configfile` still installs 0.3.1. Each release's tarball comes with a `SHA256SUMS` file and a build provenance attestation, which `gh attestation verify configfile-1.0.0.tgz --repo mindsers/configfile` checks.

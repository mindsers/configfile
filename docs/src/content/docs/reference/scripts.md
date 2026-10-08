---
title: Scripts
description: Script files and folders, per-system versions, interpreters and environment variables.
---

Every file of `scripts/`, and every folder of `scripts/` (or symbolic link to a folder) containing an `index` file (`index`, `index.sh`, …), is a **script**. Hidden files are ignored. To only use some extensions, set `script_extensions` in the [configuration](/reference/configuration/).

A script's name is its file name (or folder name) up to the first dot, with the same rules as module names: `scripts/setup.sh` is named `setup`. When two scripts have the same name, only the first one, alphabetically, is used, with a warning.

A script can have a version for each system: `macos` or `linux` after the first dot (`scripts/setup.macos.sh`, `scripts/setup.linux.py`, or a folder such as `scripts/setup.macos/`). On macOS, `configfile scripts run setup` runs `setup.macos.sh`; on another system, it runs the generic `setup.sh`, if there is one. A version for another system is ignored.

Scripts can be written in any language:

- a script with a shebang line (such as `#!/usr/bin/env python3`) is run directly when it is executable, and with that interpreter otherwise;
- a `.js` (or `.mjs`, `.cjs`) or `.sh` script without shebang line is run with `node` or `sh`;
- any other executable file (such as a compiled program) is run directly.

*configfile* never changes the permissions of your files. Scripts run in the current folder, their output is not modified (the messages of *configfile* go to stderr), and their exit code is forwarded.

Scripts get these environment variables, in addition to *configfile*'s own environment (they replace variables of the same name):

| Variable | Value |
| --- | --- |
| `CONFIGFILE_REPO` | the full path of the dotfiles repository (`folder_path`), to reach its files: `"$CONFIGFILE_REPO/Brewfile"` |
| `CONFIGFILE_SCRIPT` | the script's name (`setup`) |
| `CONFIGFILE_OS` | the system: `macos` or `linux`, as in the names of script versions |

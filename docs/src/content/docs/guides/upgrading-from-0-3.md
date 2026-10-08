---
title: Upgrading from 0.3
description: What changes for users of configfile 0.3.
---

- Node.js 24.11 or later is required, on macOS or Linux. Install again as described in [Installation](/getting-started/installation/). To switch to Homebrew, remove the npm version first (`npm uninstall --global configfile`).
- `~/.configfilerc`, the repository layout and `settings.json` work as before, including `settings.json` files that are a plain list (the 0.3.1 format, deprecated: put the list in a `"files"` key). Links deployed by 0.3 are recognised as deployed.
- If you installed 0.3 with Yarn, remove it first: `yarn global remove configfile`.
- `"global": true | false` still works but is deprecated: replace it with `"deploy": "global" | "local"`.
- A **relative** `target_path` of a global file is now relative to your home folder, not to the folder you run *configfile* from. Targets starting with `~/` or `/` are not affected.
- Scripts keep their names (up to the first dot) and every file of `scripts/` is still a script. They are no longer made executable by *configfile*: a script needs a shebang line, a `.js`/`.sh` extension, or to be executable.
- Targets inside the dotfiles repository, or containing it, are now refused.
- `modules undeploy` also removes the links made by 0.3 that point to the repository, but it only restores the backups it made itself (recorded in `~/.configfile/state.json`): the `.old` files made by 0.3 are not put back, and local copies made by 0.3 are kept.
- A `source_path` must stay inside its module folder.
- `init` clones into `~/.configfile/dotfiles` by default, and an existing `folder_path` is kept. `update` now makes that folder identical to the remote, saving local changes as a patch first. If your configured folder is also your working copy (for example `~/.dotfiles`), give *configfile* its own copy: run `configfile modules undeploy --all` (files that 1.0 moved aside come back; links made by 0.3 are removed, and their `.old` files stay where they are), then `configfile init --force --repo <url> --folder ~/.configfile/dotfiles`, then `configfile modules deploy --all` (links now point to the copy).
- With `script_extensions` set, only files with one of these extensions are scripts, and `""` means files without extension (0.3 matched any file containing the text).
- Commands now exit with a non-zero code on failure.

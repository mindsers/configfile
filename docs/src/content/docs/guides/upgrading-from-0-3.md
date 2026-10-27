---
title: Upgrading from 0.3
description: What changes for users of configfile 0.3.
sidebar:
  order: 5
---

- With Homebrew or npm, Node.js 24.11 or later is required, on macOS or Linux; the standalone binary needs none. Install again as described in [Installation](/getting-started/installation/). To switch to Homebrew or the install script, remove the npm version first (`npm uninstall --global configfile`).
- `~/.configfilerc` works as before. The settings of a module are now read from `configfile.module.json` instead of `settings.json` ([rename them](/guides/upgrading-from-1/#rename-the-settings-of-your-modules)), and settings that are a plain list (the 0.3 format) are no longer read: put the list in a `"files"` key, `{ "files": [ ... ] }`. Links deployed by 0.3 are recognised, and `modules deploy` turns them into copies, as it does for 1.x ([Upgrading from 1.x](/guides/upgrading-from-1/)).
- If you installed 0.3 with Yarn, remove it first: `yarn global remove configfile`.
- `"global": true | false` is no longer read: replace it with `"deploy": "global" | "local"`.
- A **relative** `target_path` of a global file is now relative to your home folder, not to the folder you run *configfile* from. Targets starting with `~/` or `/` are not affected.
- Scripts keep their names (up to the first dot) and every file of `scripts/` is still a script. They are no longer made executable by *configfile*: a script needs a shebang line, a `.js`/`.sh` extension, or to be executable.
- Targets inside the dotfiles repository, or containing it, are now refused.
- `modules undeploy` also removes the links made by 0.3 that point to the repository, but it only restores the backups it made itself (recorded in `~/.configfile/state.json`): the `.old` files made by 0.3 are not put back, and local copies made by 0.3 are kept.
- A `source_path` must stay inside its module folder.
- *configfile* now keeps its own copy of your repository, in `~/.configfile/dotfiles`, and `update` makes it identical to the remote. Your configured `folder_path` (for example `~/.dotfiles`) is your own clone: give *configfile* its own copy with `configfile init --force --repo <url> --working-copy ~/.dotfiles` (rename the modules' `settings.json` first, as above: a module it cannot read stops it, unless `--no-hooks`). It writes a new configuration, so add back `script_extensions` if you set it (see below). It undeploys every module first (links made by 0.3 are removed, and their `.old` files stay where they are), keeps your clone, since it did not clone it, and clones the repository into `~/.configfile/dotfiles`. Then run `configfile modules deploy --all` (the files are now copied from it).
- With `script_extensions` set, only files with one of these extensions are scripts, and `""` means files without extension (0.3 matched any file containing the text).
- Commands now exit with a non-zero code on failure.

# configfile

[![npm](https://img.shields.io/npm/v/configfile.svg?style=flat-square)](https://www.npmjs.com/package/configfile)
[![npm](https://img.shields.io/npm/dt/configfile.svg?style=flat-square)](https://www.npmjs.com/package/configfile)
[![CI](https://img.shields.io/github/actions/workflow/status/mindsers/configfile/ci.yml?branch=develop&style=flat-square)](https://github.com/mindsers/configfile/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/l/configfile.svg?style=flat-square)](https://github.com/mindsers/configfile/blob/develop/LICENSE)
[![Patreon](https://img.shields.io/badge/support-patreon-F96854.svg?logo=patreon&style=flat-square)](https://www.patreon.com/bePatron?u=9715649)

*configfile* is a command line tool that helps you manage your configuration files (dotfiles) and setup scripts from a git repository.

## Requirements

- macOS or Linux
- Node.js 22.13 or later
- git

## Installation

```bash
npm install --global configfile
```

## Data storage

This tool **does not store** configuration files for you. A git repository ([dotfiles](https://github.com/topics/dotfiles)) is needed to store your configuration files.

You edit your dotfiles in your own working copy of that repository and push them. *configfile* keeps its own copy, a mirror of the remote repository in `~/.configfile/dotfiles`, and deploys from it: `configfile update` makes the mirror identical to the remote, so unpushed or conflicting work never blocks it. Don't edit the mirror (or deployed links, which point into it): see [`update`](#usage) for what happens to such changes.

The repository must have this structure:

```txt
files/
    zsh/
        settings.json
        zshrc
    git/
        settings.json
        gitconfig
scripts/
    setup.sh
    macos/
        index.sh
```

### Modules

Every folder of `files/` (or symbolic link to a folder) that contains a `settings.json` is a **module**. Its name is the folder name, lowercased, with spaces replaced by `-` and other characters than ASCII letters, digits, `_` and `-` removed: `My Zsh.d` is the `my-zshd` module. Hidden folders are ignored.

`settings.json` lists the files of the module:

```json
{
  "files": [
    { "source_path": "zshrc", "target_path": "~/.zshrc", "deploy": "global" },
    { "source_path": "editorconfig", "target_path": ".editorconfig", "deploy": "local" },
    { "source_path": "old-aliases", "target_path": "~/.aliases", "deploy": "none" }
  ]
}
```

| Key | Description |
| --- | --- |
| `source_path` | Path of the file (or folder), relative to the module folder. It must stay inside the module folder, symbolic links included. |
| `target_path` | Where the file is deployed. `~` is your home folder. A relative path is relative to your home folder for global files (`.zshrc` is `~/.zshrc`) and to the current folder for local files. Targets can be anywhere you can write, except: your home folder, the current folder, the dotfiles repository, the module folder, *configfile*'s own files (`~/.configfilerc`, `~/.configfile/`), one of their parents, or anything inside the repository. These are recognised whatever the path used to reach them (letter case, symbolic links). |
| `deploy` | `"global"`: the file is **symlinked** by `configfile modules deploy`. `"local"`: the file is **copied** by `configfile modules deploy --local`, typically into a project folder (symbolic links in the source are followed, so the copy never points into the repository). `"none"`: the file is **never deployed**, which keeps it in the repository for later. |
| `global` | **Deprecated**, removed in 2.0: older spelling of `deploy`. `true` is `"global"`, `false` is `"local"`. It still works in 1.x, with a warning. Use one or the other, not both. |

An entry without `deploy` or `global` is not deployed, and `modules deploy` warns about it.

When a global file is deployed and something else already exists at its target (a file, a folder or another link), it is moved to `<target>.old` (or `<target>.old.1`, …). A link that already points to the right file is left as is, so deploying twice is safe.

When a local file already exists and differs from the one in the repository, *configfile* asks whether to replace it, once the other files are deployed. The existing file or folder is then moved to `<target>.old` (or `.old.1`, …) before the copy, so nothing is lost.

*configfile* records what it deploys and the backups it makes in `~/.configfile/state.json`. `configfile modules undeploy` reverts a deployment: it removes the links and the local copies *configfile* made (unless they were modified since), and moves the most recent backup it made back in place, if that backup is unchanged. Anything else is left untouched: files it did not create (even when identical to the repository), local copies that were modified or saved again by an editor since, and `.old` files you made yourself.

Only one *configfile* at a time changes files: a second one waits for the first to finish (the lock is `~/.configfile/lock`).

> **Deploying a repository means trusting it**, like code you run: its files end up in your shell configuration, and its scripts run on your machine. Only deploy repositories you trust.

### Scripts

Every file of `scripts/`, and every folder of `scripts/` (or symbolic link to a folder) containing an `index` file (`index`, `index.sh`, …), is a **script**. Hidden files are ignored. To only use some extensions, set `script_extensions` in the [configuration](#configuration).

A script's name is its file name up to the first dot, or its folder name, with the same rules as module names: `scripts/setup.sh` and `scripts/setup.macos.py` are both named `setup` (only the first one, alphabetically, is used, with a warning).

Scripts can be written in any language:

- a script with a shebang line (such as `#!/usr/bin/env python3`) is run directly when it is executable, and with that interpreter otherwise;
- a `.js` (or `.mjs`, `.cjs`) or `.sh` script without shebang line is run with `node` or `sh`;
- any other executable file (such as a compiled program) is run directly.

*configfile* never changes the permissions of your files. Scripts run in the current folder, their output is not modified (the messages of *configfile* go to stderr), and their exit code is forwarded.

## Usage

- `configfile init` (`i`): ask for the URL of your dotfiles repository, clone it into `~/.configfile/dotfiles` and save the configuration in `~/.configfilerc`. If the folder already contains a git repository, it is used as is. When you run `init` again, the existing folder is kept.
    - `-f, --force`: overwrite an existing configuration without asking.
    - `--repo <url>`: give the URL from the command line, for non-interactive setups.
    - `--folder <path>`: clone somewhere else than `~/.configfile/dotfiles`.
- `configfile modules list` (`m l`, or just `configfile modules`): list available modules.
- `configfile modules status [modules...]` (`m st`): show whether each global file of the modules (all modules by default) is deployed, not deployed, or blocked by another file.
    - `-l, --local`: check the local files, in the current folder.
- `configfile modules deploy [modules...]` (`m d`): deploy the global files of the given modules. Without module names, asks to deploy all modules.
    - `-l, --local`: copy the local files of the modules instead.
    - `-a, --all`: deploy every module without asking.
    - `-f, --force`: replace existing local files without asking (they are moved to `.old`).
    - `-n, --dry-run`: show what would be done, without changing anything.
- `configfile modules undeploy [modules...]` (`m u`): remove the deployed global files of the given modules and restore their backups. Without module names, asks to undeploy all modules.
    - `-l, --local`, `-a, --all` and `-n, --dry-run`: as for `deploy`.
- `configfile scripts list` (`s l`, or just `configfile scripts`): list available scripts.
- `configfile scripts run <name> [-- args...]` (`s r`): run a script. Arguments after `--` are passed to the script.
- `configfile update` (`u`): sync *configfile*'s copy of your dotfiles repository with the remote: it fetches the remote and makes the copy identical to it, whatever happened to the copy. Local changes found in the copy (uncommitted edits, new files or unpushed commits, for example edits made through a deployed link) are first saved as a patch in `~/.configfile/saved/`; apply it in your own working copy with `git am <patch>` to keep them. Global files are symbolic links, so they are up to date right away; run `modules deploy --all` for new files, and `modules deploy --local` to refresh local copies.
- `configfile history`: show what *configfile* changed, most recent last (see [History](#history)).
    - `-n, --limit <count>`: number of runs to show (20 by default).
    - `--json`: print the raw history lines (JSON Lines), for scripts.

*configfile* exits with a non-zero code when a command fails, and with the script's exit code when a script fails, so it can be used from other scripts. When stdin is not a terminal, a command that would ask a question fails and names the option to pass instead (`--repo`, `--folder` and `--force` for `init`; module names or `--all` for `modules deploy` and `undeploy`). Without a terminal, `modules deploy --local` skips existing local files and exits with an error, unless `--force` is given. Ctrl+C at a question exits with code 130. Each run that changes something is also recorded in the [history](#history).

### Configuration

*configfile* keeps its configuration in `~/.configfilerc`, and its working files in the `~/.configfile/` folder: the mirror of your repository (`dotfiles/`), the record of deployments (`state.json`), the [history](#history) (`history.jsonl`), the lock, and saved local changes (`saved/`).

`~/.configfilerc` is a JSON file:

```json
{
  "repo_url": "git@github.com:me/dotfiles.git",
  "folder_path": "/Users/me/.configfile/dotfiles",
  "script_extensions": [".js", ".sh", ""],
  "history_max_size": "1MB"
}
```

`folder_path` may start with `~`; a relative path is relative to your home folder. `script_extensions` is optional: without it, every file of `scripts/` is a script. With it, only files with one of these extensions are; the dot may be omitted (`"py"`), and `""` means files without extension. `history_max_size` is optional: see [History](#history).

### History

*configfile* records what each command changed, when, and whether it failed, in `~/.configfile/history.jsonl`: one JSON line per run of `init`, `modules deploy`, `modules undeploy`, `update` and `scripts run` (dry runs excepted), and per unexpected error of any command. Each line has the time, the *configfile* version, the command and its options, the current folder, the exit code, the error message, and the changes: files linked, copied, moved aside to `.old`, removed, restored, kept or skipped, syncs (from which commit to which, and saved patches), scripts and their exit codes.

Script arguments, environment variables and file contents are never recorded, and passwords or tokens in URLs are hidden. The file is only readable by its owner.

`configfile history` shows the last runs:

```txt
2026-10-01 11:12  modules deploy zsh  ok
  linked    ~/.zshrc  (previous file moved to ~/.zshrc.old)
  2 unchanged
```

The file is also easy to query with `jq`, for example to list the failed runs:

```bash
jq 'select(.exitCode != 0)' ~/.configfile/history.jsonl
```

When the file reaches `history_max_size` (1MB by default; a number of bytes, or a size such as `"512KB"` or `"5MB"` in `~/.configfilerc`), it is renamed to `history.1.jsonl`, replacing the previous one, so the history takes about twice that size at most. `"history_max_size": 0` turns the history off.

## Upgrading from 0.3

- Node.js 22.13 or later is required, on macOS or Linux. Install again with `npm install --global configfile`.
- `~/.configfilerc`, the repository layout and `settings.json` work as before, including `settings.json` files that are a plain list (the 0.3.1 format, deprecated: put the list in a `"files"` key). Links deployed by 0.3 are recognised as deployed.
- If you installed 0.3 with Yarn, remove it first: `yarn global remove configfile`.
- `"global": true | false` still works but is deprecated: replace it with `"deploy": "global" | "local"`.
- A **relative** `target_path` of a global file is now relative to your home folder, not to the folder you run *configfile* from. Targets starting with `~/` or `/` are not affected.
- Scripts keep their names (up to the first dot) and every file of `scripts/` is still a script. They are no longer made executable by *configfile*: a script needs a shebang line, a `.js`/`.sh` extension, or to be executable.
- Targets inside the dotfiles repository, or containing it, are now refused.
- `modules undeploy` only removes what 1.0 or later deployed, and only restores backups it made (recorded in `~/.configfile/state.json`): local copies and `.old` files made by 0.3 stay where they are.
- A `source_path` must stay inside its module folder.
- `init` clones into `~/.configfile/dotfiles` by default, and an existing `folder_path` is kept. `update` now makes that folder identical to the remote, saving local changes as a patch first. If your configured folder is also your working copy (for example `~/.dotfiles`), give *configfile* its own copy: run `configfile modules undeploy --all` (your previous files come back), then `configfile init --force --repo <url> --folder ~/.configfile/dotfiles`, then `configfile modules deploy --all` (links now point to the copy).
- With `script_extensions` set, only files with one of these extensions are scripts, and `""` means files without extension (0.3 matched any file containing the text).
- Commands now exit with a non-zero code on failure.

## Contribution

Contributions to the source code of *configfile* are welcome and greatly appreciated. For help on how to contribute to this project, please refer to [How to contribute to Configfile](https://github.com/mindsers/configfile/blob/develop/CONTRIBUTING.md).

## Support

*configfile* is licensed under an Apache-2.0 license, which means that it's a completely free open source software. Unfortunately, *configfile* doesn't make itself.

If you're using *configfile* and want to support the development, you now have the chance! Go on my [Patreon page](https://www.patreon.com/mindsers) and become my joyful patron!!

[![Become a Patron!](https://c5.patreon.com/external/logo/become_a_patron_button.png)](https://www.patreon.com/bePatron?u=9715649)

For help on how to support Configfile, please refer to [The awesome people who support Configfile](https://github.com/mindsers/configfile/blob/develop/SPONSORS.md).

## License

This project is under Apache-2.0 license. See LICENSE file.

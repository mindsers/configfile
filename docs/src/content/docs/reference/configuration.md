---
title: Configuration
description: The ~/.configfilerc file and the ~/.configfile/ folder.
---

*configfile* keeps its configuration in `~/.configfilerc`, and its working files in the `~/.configfile/` folder: the mirror of your repository (`dotfiles/`), the record of deployments (`state.json`), the [history](/reference/history/) (`history.jsonl`), the lock, and saved local changes (`saved/`).

*configfile* has two kinds of settings. `~/.configfilerc` describes **this machine**: where it gets the repository, its working copy, its profiles, how *configfile* runs here. [`configfile.repository.json`](/reference/modules/#repository-settings), at the root of the repository, describes **the repository**, and is the same on every machine. A setting never lives in both: one that two machines using the same repository could want different belongs to `~/.configfilerc`.

`~/.configfilerc` is a JSON file, readable by you only: the repository URL may contain credentials, so if other users can read it, *configfile* makes it private and warns you.

```json
{
  "repo_url": "git@github.com:me/dotfiles.git",
  "folder_path": "/Users/me/.configfile/dotfiles",
  "script_extensions": [".js", ".sh", ""],
  "history_max_size": "1MB",
  "working_copy": "~/src/dotfiles",
  "profiles": ["work"]
}
```

`folder_path` may start with `~`; a relative path is relative to your home folder. `script_extensions` is optional: without it, every file of `scripts/` is a script. With it, only files with one of these extensions are; the dot may be omitted (`"py"`), and `""` means files without extension. `history_max_size` is optional: see [History](/reference/history/). `working_copy` is optional: it is your own clone of the repository, where [`modules adopt`](/reference/commands/#configfile-modules-adopt) commits, and from which [`update`](/reference/commands/#configfile-update) pushes the commits the remote doesn't have before syncing. `init --working-copy` and the first `modules adopt --into` save it; like `folder_path`, it may start with `~`. `profiles` is optional: the profiles of this machine, which the [`when` conditions](/reference/modules/#deploy-on-some-machines-only) of the modules name. `init --profile` and `init`'s question save them; edit them here afterwards. A name is made of letters, digits, `.`, `_` and `-`, and starts with a letter or a digit.

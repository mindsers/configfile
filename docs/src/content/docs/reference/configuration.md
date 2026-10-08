---
title: Configuration
description: The ~/.configfilerc file and the ~/.configfile/ folder.
---

*configfile* keeps its configuration in `~/.configfilerc`, and its working files in the `~/.configfile/` folder: the mirror of your repository (`dotfiles/`), the record of deployments (`state.json`), the [history](/reference/history/) (`history.jsonl`), the lock, and saved local changes (`saved/`).

`~/.configfilerc` is a JSON file, readable by you only: the repository URL may contain credentials, so if other users can read it, *configfile* makes it private and warns you.

```json
{
  "repo_url": "git@github.com:me/dotfiles.git",
  "folder_path": "/Users/me/.configfile/dotfiles",
  "script_extensions": [".js", ".sh", ""],
  "history_max_size": "1MB"
}
```

`folder_path` may start with `~`; a relative path is relative to your home folder. `script_extensions` is optional: without it, every file of `scripts/` is a script. With it, only files with one of these extensions are; the dot may be omitted (`"py"`), and `""` means files without extension. `history_max_size` is optional: see [History](/reference/history/).

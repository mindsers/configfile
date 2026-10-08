---
title: History
description: What configfile records about each run, and how to read it.
---

*configfile* records what each command changed, when, and whether it failed, in `~/.configfile/history.jsonl`: one JSON line per run of `init`, `modules deploy`, `modules undeploy`, `update` and `scripts run` (dry runs and usage errors excepted), and per unexpected error of any command. Each line has the time, the *configfile* version, the command and its options, the current folder, the exit code, the error message, and the changes: files linked, copied, moved aside to `.old`, removed, restored, kept or skipped, syncs (from which commit to which, and saved patches), scripts and their exit codes.

Script arguments, environment variables and file contents are never recorded. In URLs, user names and passwords (`https://user:token@host`) and query parameters that look like secrets (`?private_token=…`) are hidden. Paths are recorded in full, so they include your user name. When *configfile* creates the file, only its owner can read it. A run stopped by a signal (Ctrl+C outside a question) is not recorded, unless the signal comes while a script or git runs: *configfile* then leaves it to that program, and records the run with its exit code.

`configfile history` shows the last runs:

```txt
2026-10-01 11:12  modules deploy zsh  ok
  linked    ~/.zshrc  (previous file moved to ~/.zshrc.old)
  2 unchanged

2026-10-01 11:15  update  exit 128
  error     git fetch failed (exit code 128).
```

`-n <count>` shows another number of runs, and `--json` prints the lines as they are written.

The file is also easy to query with `jq`, for example to list the failed runs:

```bash
jq 'select(.exitCode != 0)' ~/.configfile/history.jsonl
```

When the file reaches `history_max_size` (1MB by default; a number of bytes, or a size such as `"512KB"` or `"5MB"` in `~/.configfilerc`), it is renamed to `history.1.jsonl`, replacing the previous one, so the history takes about twice that size at most. `"history_max_size": 0` turns the history off. An invalid value gives the default and a warning; when `~/.configfilerc` cannot be read, nothing is recorded.

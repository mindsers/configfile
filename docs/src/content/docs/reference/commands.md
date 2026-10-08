---
title: Commands
description: Every configfile command and option, exit codes, and use without a terminal.
---

- `configfile init` (`i`): ask for the URL of your dotfiles repository (any URL git can clone, such as `https://github.com/me/dotfiles.git` or `git@github.com:me/dotfiles.git`, or an existing local folder), clone it into `~/.configfile/dotfiles` and save the configuration in `~/.configfilerc`. If the folder already contains a git repository, it is used as is. When you run `init` again, the existing folder is kept.
    - `-f, --force`: overwrite an existing configuration without asking.
    - `--repo <url>`: give the URL from the command line, for non-interactive setups.
    - `--folder <path>`: clone somewhere else than `~/.configfile/dotfiles`.
- `configfile modules list` (`m l`, or just `configfile modules`): list available modules.
- `configfile modules status [modules...]` (`m st`): show whether each global file of the modules (all modules by default) is deployed, not deployed, or blocked by another file. Without module names, it also lists the deployed files the repository no longer deploys.
    - `-l, --local`: check the local files, in the current folder.
- `configfile modules deploy [modules...]` (`m d`): deploy the global files of the given modules. Without module names, asks to deploy all modules.
    - `-l, --local`: copy the local files of the modules instead.
    - `-a, --all`: deploy every module without asking.
    - `-f, --force`: replace existing local files without asking (they are moved to `.old`).
    - `-n, --dry-run`: show what would be done, without changing anything.
- `configfile modules undeploy [modules...]` (`m u`): remove the deployed global files of the given modules and restore their backups. Without module names, asks to undeploy all modules.
    - `-a, --all`: undeploy every module without asking, and the files the repository no longer deploys.
    - `--removed`: only undeploy the files the repository no longer deploys (see [Modules](/reference/modules/)); with `--local`, the copies made in the current folder.
    - `-l, --local` and `-n, --dry-run`: as for `deploy`.
- `configfile scripts list` (`s l`, or just `configfile scripts`): list available scripts.
- `configfile scripts run <name> [-- args...]` (`s r`): run a script. Arguments after `--` are passed to the script.
- `configfile update` (`u`): sync *configfile*'s copy of your dotfiles repository with the remote: it fetches the remote and makes the copy identical to it, whatever happened to the copy. Local changes found in the copy (uncommitted edits, new files or unpushed commits, for example edits made through a deployed link) are first saved as a patch in `~/.configfile/saved/`; apply it in your own working copy with `git am <patch>` to keep them. Global files are symbolic links, so they are up to date right away; run `modules deploy --all` for new files, and `modules deploy --local` to refresh local copies. It warns about deployed files the repository no longer deploys.
- `configfile history`: show what *configfile* changed, most recent last (see [History](/reference/history/)).
    - `-n, --limit <count>`: number of runs to show (20 by default).
    - `--json`: print the raw history lines (JSON Lines), for scripts.

*configfile* exits with a non-zero code when a command fails, and with the script's exit code when a script fails, so it can be used from other scripts. When stdin is not a terminal, a command that would ask a question fails and names the option to pass instead (`--repo`, `--folder` and `--force` for `init`; module names or `--all` for `modules deploy` and `undeploy`). Without a terminal, `modules deploy --local` skips existing local files and exits with an error, unless `--force` is given. Ctrl+C at a question exits with code 130. Each run of a command that changes files, and any unexpected error, is also recorded in the [history](/reference/history/).

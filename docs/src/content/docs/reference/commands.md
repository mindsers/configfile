---
title: Commands
description: Every configfile command and option, exit codes, and use without a terminal.
---

Every command prints its own help with `--help`, and most have a short form, shown under their usage. The usage lines and the tables of arguments and options below are generated from *configfile* itself.

## `configfile init`

Asks for the URL of your dotfiles repository (any URL git can clone, such as `https://github.com/me/dotfiles.git` or `git@github.com:me/dotfiles.git`, or an existing local folder), clones it into `~/.configfile/dotfiles` and saves the configuration in `~/.configfilerc`. If the folder already contains a git repository, it is used as is. When you run `init` again, the existing folder is kept.

<!-- generated: configfile init -->
```sh
configfile init [options]
```

Short form: `configfile i`.

| Argument or option | Description |
| --- | --- |
| `-f, --force` | overwrite the existing configuration without asking |
| `--repo <url>` | dotfiles repository URL (skips the question) |
| `--folder <path>` | where to clone the repository (default: ~/.configfile/dotfiles) |
<!-- /generated -->

## `configfile modules list`

Lists the available modules. `configfile modules` alone does the same.

<!-- generated: configfile modules list -->
```sh
configfile modules list [options]
```

Short form: `configfile m l`.
<!-- /generated -->

## `configfile modules status`

Shows whether each global file of the modules (all modules by default) is deployed, not deployed, or blocked by another file. Without module names, it also lists the deployed files the repository no longer deploys. With `--local`, it checks the local files, in the current folder.

<!-- generated: configfile modules status -->
```sh
configfile modules status [options] [modules...]
```

Short form: `configfile m st`.

| Argument or option | Description |
| --- | --- |
| `modules` | modules to check (all when omitted) |
| `-l, --local` | check the local files of the modules, in the current folder |
<!-- /generated -->

## `configfile modules deploy`

Deploys the global files of the given modules. Without module names, asks to deploy all modules. With `--local`, copies the local files of the modules instead.

<!-- generated: configfile modules deploy -->
```sh
configfile modules deploy [options] [modules...]
```

Short form: `configfile m d`.

| Argument or option | Description |
| --- | --- |
| `modules` | modules to deploy (use --all, or answer a question, when omitted) |
| `-l, --local` | copy the local files of the modules instead of linking global files |
| `-a, --all` | deploy every module without asking |
| `-f, --force` | replace existing local files without asking (they are moved to .old) |
| `-n, --dry-run` | show what would be done, without changing anything |
<!-- /generated -->

## `configfile modules undeploy`

Removes the deployed global files of the given modules and restores their backups. Without module names, asks to undeploy all modules. `--local` and `--dry-run` work as for `deploy`. `--removed` only undeploys the files the repository no longer deploys (see [Modules](/reference/modules/)); with `--local`, the copies made in the current folder.

<!-- generated: configfile modules undeploy -->
```sh
configfile modules undeploy [options] [modules...]
```

Short form: `configfile m u`.

| Argument or option | Description |
| --- | --- |
| `modules` | modules to undeploy (use --all, or answer a question, when omitted) |
| `-l, --local` | remove the local copies of the modules instead of global links |
| `-a, --all` | undeploy every module without asking, and the files the repository no longer deploys |
| `--removed` | only undeploy the files the repository no longer deploys |
| `-n, --dry-run` | show what would be done, without changing anything |
<!-- /generated -->

## `configfile scripts list`

Lists the available scripts. `configfile scripts` alone does the same.

<!-- generated: configfile scripts list -->
```sh
configfile scripts list [options]
```

Short form: `configfile s l`.
<!-- /generated -->

## `configfile scripts run`

Runs a script. Arguments after `--` are passed to the script.

<!-- generated: configfile scripts run -->
```sh
configfile scripts run [options] <name> [args...]
```

Short form: `configfile s r`.

| Argument or option | Description |
| --- | --- |
| `name` | script to run |
| `args` | arguments passed to the script (put them after "--") |
<!-- /generated -->

## `configfile update`

Syncs *configfile*'s copy of your dotfiles repository with the remote: it fetches the remote and makes the copy identical to it, whatever happened to the copy. Local changes found in the copy (uncommitted edits, new files or unpushed commits, for example edits made through a deployed link) are first saved as a patch in `~/.configfile/saved/`; apply it in your own working copy with `git am <patch>` to keep them. Global files are symbolic links, so they are up to date right away; run `modules deploy --all` for new files, and `modules deploy --local` to refresh local copies. It warns about deployed files the repository no longer deploys.

<!-- generated: configfile update -->
```sh
configfile update [options]
```

Short form: `configfile u`.
<!-- /generated -->

## `configfile history`

Shows what *configfile* changed, most recent last (see [History](/reference/history/)).

<!-- generated: configfile history -->
```sh
configfile history [options]
```

| Argument or option | Description |
| --- | --- |
| `-n, --limit <count>` | number of runs to show (default: 20) |
| `--json` | print the raw history lines (JSON Lines), for scripts |
<!-- /generated -->

## Exit codes and use in scripts

*configfile* exits with a non-zero code when a command fails, and with the script's exit code when a script fails, so it can be used from other scripts. When stdin is not a terminal, a command that would ask a question fails and names the option to pass instead (`--repo`, `--folder` and `--force` for `init`; module names or `--all` for `modules deploy` and `undeploy`). Without a terminal, `modules deploy --local` skips existing local files and exits with an error, unless `--force` is given. Ctrl+C at a question exits with code 130. Each run of a command that changes files, and any unexpected error, is also recorded in the [history](/reference/history/).

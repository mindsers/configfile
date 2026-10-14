---
title: Safety and trust
description: What deploying a repository means, how configfile keeps a copy of what it replaces, and what it refuses to touch.
sidebar:
  order: 2
---

*configfile* replaces files in your home folder, where your shell, editor and tools keep their configuration. This page explains what you trust when you deploy a repository, the precautions *configfile* takes before replacing a file, and the cases where it refuses to act. The [modules reference](/reference/modules/) gives the exact rules.

## Deploying a repository means trusting it

The files of a repository end up in your shell's and your tools' configuration, and its scripts run on your machine with your permissions, including the scripts a module names, which `modules deploy` and `modules undeploy` run by themselves (`--dry-run` lists them, `--no-hooks` skips them). Treat deploying a dotfiles repository like running its code: only deploy repositories you trust, and read a shared one before using it.

## A copy of what is replaced

- **Global files:** when something already exists where a file is deployed (a file, a folder or another link), it is moved aside to `<target>.old` (or `.old.1`, `.old.2`…) before the link is created. A link that already points to the right file is left as it is, so deploying twice is safe; an outdated link *configfile* made itself is simply replaced.
- **Local files:** an existing file that differs from the repository, whether *configfile* copied it or not, is only replaced after you answer yes (or with `--force`), and it is moved aside to `.old` the same way. Without a terminal to ask in, it is skipped and the command exits with an error.
- **Preview:** `--dry-run` on `modules deploy` and `modules undeploy` shows what would happen, without changing anything.

Apart from the backup that `undeploy` puts back in place, `.old` files stay where they are: delete the ones you no longer need.

## What undeploy removes

`configfile modules undeploy` uses the record *configfile* keeps (see [Keeping track](/concepts/how-it-works/#keeping-track)):

- it removes the links that point to the repository's files, including those made by *configfile* 0.3, and the local copies it made, as long as a copy is still the file it made and matches the repository's current version;
- it moves the most recent backup it made back in place, if that backup is unchanged.

Everything else stays: files it didn't create, even when they are identical to the repository (links to the repository's files excepted, as above); local copies that differ from the repository (because you changed them, or because the repository changed since) or that an editor saved again; and `.old` files it didn't make.

## When in doubt, nothing is removed

*configfile* doesn't remove a deployed file when it cannot tell whether the repository still deploys it, for example when the file's module cannot be read, or when it doesn't know which entry the file comes from. `modules status` lists such files separately, so that you can fix the module.

## Refused targets

A `target_path` can't put something important at risk: your home folder, the current folder, the dotfiles repository and its modules, or *configfile*'s own files (`~/.configfilerc`, `~/.configfile/`). Targets are checked by what they are, not by how they are written, so a symbolic link or different letter case doesn't get around the check. In the same way, a `source_path` must stay inside its module.

## Deployments don't overlap

`modules deploy` and `modules undeploy` change files one at a time across processes: while one runs, another one (except a dry run) waits for it, up to 10 seconds, then stops with an error, which names the other process when it can. The lock is `~/.configfile/lock`; the lock of a process that no longer exists is taken over. Both take it for the files of each module in turn, and release it while a script of the module runs, so that script can run *configfile* itself. Another deployment can therefore take its turn between two modules; files are still never changed by two processes at once.

`update` takes the same lock for the whole sync, from fetching the remote to resetting the mirror, and `init` while it clones or reuses the repository and saves the configuration. A deployment and a sync therefore never overlap: one waits for the other. As the lock is released between two modules, an `update` can still run in the middle of `modules deploy --all`; the modules after it are then deployed from the synced repository, with the settings read when the deployment started. `scripts run` doesn't take the lock, as a script can run for a long time and run *configfile* itself: don't run scripts during an `update`.

## Your configuration and history stay private

- `~/.configfilerc` is readable by you only, since the repository URL may contain credentials. If other users can read it, *configfile* makes it private and warns you. `init` also warns when the URL contains credentials; an SSH key or a git credential helper is safer.
- The [history](/reference/history/) never records script arguments, environment variables or file contents. It hides passwords and tokens in URLs (an SSH user name such as `git` is kept) and query parameters that look like secrets. It does record full paths, which include your user name.

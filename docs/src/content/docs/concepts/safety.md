---
title: Safety and trust
description: What deploying a repository means, how configfile keeps a copy of what it replaces, and what it refuses to touch.
sidebar:
  order: 2
---

*configfile* replaces files in your home folder, where your shell, editor and tools keep their configuration. This page explains what you trust when you deploy a repository, the precautions *configfile* takes before replacing a file, and the cases where it refuses to act. The [modules reference](/reference/modules/) gives the exact rules.

## Deploying a repository means trusting it

The files of a repository end up in your shell's and your tools' configuration, and its scripts run on your machine with your permissions, including the scripts a module names, which `modules deploy` and `modules undeploy` run by themselves (`--dry-run` lists them, `--no-hooks` skips them), and the scripts the repository names: `update` runs its `post_update` script by itself (`--no-hooks` skips it), and `init` asks before running its `post_init` script. Treat deploying a dotfiles repository like running its code: only deploy repositories you trust, and read a shared one before using it.

## A copy of what is replaced

- **Global files:** when something already exists where a file is deployed (a file, a folder or another link), it is moved aside to `<target>.old` (or `.old.1`, `.old.2`…) before the copy or the link is created. A copy or a link already in place is left as it is, so deploying twice is safe; an outdated link *configfile* made itself is simply replaced, and so is a link it made when the entry asks for a copy (the copy keeps what the link showed).
- **Global copies:** a copy changed on this machine is never replaced unasked. A file changed both on this machine and in the repository is only replaced after you answer yes, or with `--force`, and it is moved aside to `.old` first (inside a copied folder, next to the file it replaces). Files that only exist in a copied folder, such as those a tool creates, are never touched, and *configfile* never follows a symbolic link inside a copied folder.
- **Local files:** an existing file that differs from the repository, whether *configfile* copied it or not, is only replaced after you answer yes (or with `--force`), and it is moved aside to `.old` the same way. Without a terminal to ask in, it is skipped and the command exits with an error.
- **Preview:** `--dry-run` on `modules deploy` and `modules undeploy` shows what would happen, without changing anything.

Apart from the backup that `undeploy` puts back in place, `.old` files stay where they are: delete the ones you no longer need.

## What undeploy removes

`configfile modules undeploy` uses the record *configfile* keeps (see [Keeping track](/concepts/how-it-works/#keeping-track)):

- it removes the links that point to the repository's files, including those made by *configfile* 0.3;
- it removes the global copies it made that did not change on this machine (in a copied folder, the files that did not change: the folder itself goes once it is empty);
- it removes the local copies it made, as long as a copy is still the file it made and matches the repository's current version;
- it moves the most recent backup it made back in place, if that backup is unchanged.

Everything else stays: files it didn't create, even when they are identical to the repository (links to the repository's files excepted, as above); global copies changed on this machine, and the files a tool created in a copied folder; local copies that differ from the repository (because you changed them, or because the repository changed since) or that an editor saved again; and `.old` files it didn't make.

## What update changes in your home folder

`update` syncs *configfile*'s copy of the repository, then updates the global copies the repository changed. It only rewrites or deletes files that are still what *configfile* copied: it never moves anything aside, never asks a question, never runs a module's scripts (only the repository's `post_update` script, once done), and keeps the files changed on this machine and the conflicts as they are, saying so. Each file is written through a temporary file, so a tool never reads half of one, and a file written on this machine while `update` runs is kept.

## When in doubt, nothing is removed

*configfile* doesn't remove a deployed file when it cannot tell whether the repository still deploys it, for example when the file's module cannot be read, or when it doesn't know which entry the file comes from. `modules status` lists such files separately, so that you can fix the module.

## Refused targets

A `target_path` can't put something important at risk: your home folder, the current folder, the dotfiles repository and its modules, or *configfile*'s own files (`~/.configfilerc`, `~/.configfile/`). Targets are checked by what they are, not by how they are written, so a symbolic link or different letter case doesn't get around the check. In the same way, a `source_path` must stay inside its module.

## Deployments don't overlap

`modules deploy` and `modules undeploy` change files one at a time across processes: while one runs, another one (except a dry run) waits for it, saying `Waiting for another configfile (process N) to finish…`, up to 10 seconds, then stops with an error, which names the other process when it can. The lock is `~/.configfile/lock`; the lock of a process that no longer exists is taken over, by one process at a time (`~/.configfile/lock.takeover` marks the one doing it). A lock without a process number, as configfile 1.0 leaves for a moment while it creates the lock, is waited for, never taken over. A lock that cannot be read is never taken over: its owner cannot be checked, so the command stops and says why. Both take it for the files of each module in turn, and release it while a script of the module runs, so that script can run *configfile* itself. Another deployment can therefore take its turn between two modules; files are still never changed by two processes at once.

`update` takes the same lock for the whole sync, from fetching the remote to resetting the mirror and updating the copies of global files, and `init` while it clones or reuses the repository and saves the configuration. A git prompt for a password or a passphrase during the fetch or the clone holds the lock too: run `update` and `init` where you can answer, or use an SSH key or a git credential helper. Files are therefore never deployed while a sync replaces them: one waits for the other. As the lock is released between two modules, an `update` can still run in the middle of `modules deploy --all`; the modules after it are then deployed from the synced repository, with the settings read when the deployment started. `scripts run` doesn't take the lock, as a script can run for a long time and run *configfile* itself: don't run scripts during an `update`.

## Your configuration and history stay private

- `~/.configfilerc` is readable by you only, since the repository URL may contain credentials. If other users can read it, *configfile* makes it private and warns you. `init` also warns when the URL contains credentials; an SSH key or a git credential helper is safer.
- The [history](/reference/history/) never records script arguments, environment variables or file contents. It hides passwords and tokens in URLs (an SSH user name such as `git` is kept) and query parameters that look like secrets. It does record full paths, which include your user name.

---
title: Safety and trust
description: The rules configfile follows to never lose a file, what it refuses to touch, and what deploying a repository means.
sidebar:
  order: 2
---

*configfile* replaces files in your home folder, which is where your shell, editor and tools keep their configuration. These are the rules it follows so that nothing is lost, and the cases where it refuses to act.

## Nothing is replaced without a backup

- **Global files:** when something already exists where a file is deployed (a file, a folder or another link), it is moved aside to `<target>.old` (or `.old.1`, `.old.2`…) before the link is created. A link that already points to the right file is left as it is, so deploying twice is safe.
- **Local files:** an existing copy that differs from the repository is only replaced after you answer yes (or with `--force`), and it is moved aside to `.old` the same way. Without a terminal to ask in, *configfile* skips it and exits with an error.
- **Preview:** `--dry-run` on `modules deploy` and `modules undeploy` shows what would happen, without changing anything.

## Undoing only what configfile did

`configfile modules undeploy` reverts a deployment using the [record](/concepts/how-it-works/#keeping-track) *configfile* keeps:

- it removes the links it created, and the local copies it made if they haven't been modified since;
- it moves the most recent backup it made back in place, if that backup is unchanged.

It leaves everything else alone: files it didn't create, even when they are identical to the repository; local copies you or an editor changed; and `.old` files you made yourself.

## When in doubt, nothing happens

*configfile* never removes a deployed file when it cannot tell whether the repository still deploys it: files of a module whose `settings.json` cannot be used or contains invalid entries, of a module folder that cannot be used, and of entries without a deployment strategy. `modules status` lists them separately, so you can fix the module.

## Targets configfile refuses

A `target_path` cannot point to, or contain:

- your home folder or the current folder;
- the dotfiles repository, the module's folder, or anything inside them;
- *configfile*'s own files, `~/.configfilerc` and `~/.configfile/`, or anything inside `~/.configfile/`.

These are recognised whatever the path used to reach them, including through symbolic links or with different letter case. In the same way, a `source_path` must stay inside its module's folder. The [modules reference](/reference/modules/) lists the exact rules.

## One configfile at a time

Only one *configfile* changes files at a time. A second one waits for the first to finish, using a lock file, `~/.configfile/lock`.

## Your configuration and history stay private

- `~/.configfilerc` is readable by you only, since the repository URL may contain credentials. If other users can read it, *configfile* makes it private and warns you. `init` also warns when the URL contains credentials; an SSH key or a git credential helper is safer.
- The [history](/reference/history/) never records script arguments, environment variables or file contents, and hides user names, passwords and secret-looking parameters in URLs. It does record full paths, which include your user name.

## Deploying a repository means trusting it

The files of a repository end up in your shell's and your tools' configuration, and its scripts run on your machine with your permissions. Treat deploying a dotfiles repository like running its code: only deploy repositories you trust, and read a shared one before using it.

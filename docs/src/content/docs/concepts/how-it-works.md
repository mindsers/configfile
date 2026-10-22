---
title: How it works
description: Where your dotfiles live, how configfile deploys them, and how it keeps track of what it did.
sidebar:
  order: 1
---

*configfile* doesn't store your configuration files. They live in a git repository that you own, usually called `dotfiles` ([plenty of people share theirs](https://github.com/topics/dotfiles)). *configfile* puts the files of that repository where your tools expect them, runs your setup scripts, and keeps each machine in sync with the repository.

## Where your files live

Your dotfiles exist in up to four places:

```txt
your working copy     ~/dotfiles
        │
        │  git push
        ▼
remote repository     GitHub, GitLab…
        │
        │  configfile update
        ▼
configfile's mirror   ~/.configfile/dotfiles
        │
        │  configfile modules deploy (once per file), then configfile update
        ▼
your home folder      ~/.zshrc, a copy kept up to date
```

- **Your working copy** is a clone of the repository, wherever you like. It's the only place where you edit your dotfiles, commit and push, as for any git repository. Once you tell *configfile* where it is ([`working_copy`](/reference/configuration/)), [`modules adopt`](/reference/commands/#configfile-modules-adopt) commits the files you adopt there, and `update` pushes its commits before syncing.
- **The remote repository** is the reference that every machine follows.
- **configfile's mirror** is a copy of the remote repository that *configfile* keeps for itself, in `~/.configfile/dotfiles` unless you chose another folder with `configfile init --folder`. [`configfile update`](/reference/commands/#configfile-update) makes it identical to the remote.
- **Your home folder** receives the files your tools read, such as `~/.zshrc`: copies that `update` keeps up to date, or links into the mirror. Project folders receive local copies.

### Why a mirror, and not your working copy

If *configfile* deployed from your working copy, uncommitted edits, a branch you're working on or a conflict would block syncing, and changes you haven't pushed yet would reach your configuration before your other machines have them.

The mirror only follows the remote. `update` doesn't merge anything, so your work in progress never blocks it: it fetches the remote and makes the mirror identical to it. It still needs the remote to be reachable, and stops with an error if fetching fails.

You don't edit the mirror. If something changes in it anyway, for example an edit made through a [deployed link](#changes-made-through-links), `update` first saves the uncommitted changes and unpushed commits that the remote doesn't have as a patch in `~/.configfile/saved/`, so that you can recover them, and names the files they change: apply the patch in your working copy with `git -C <your working copy> apply --3way <patch>`, then commit and push.

:::caution
`update` resets the mirror's folder, whatever it is. A configuration made with *configfile* 0.3 may point to your own working copy (for example `~/.dotfiles`): `update` would then reset your working copy to the remote, after saving its uncommitted changes and unpushed commits as a patch. [Upgrading from 0.3](/guides/upgrading-from-0-3/) explains how to give *configfile* its own copy.
:::

## The repository's layout

```txt
configfile.repository.json   the repository's settings (optional)
files/            one folder per module
    zsh/
        configfile.module.json
        zshrc
    git/
        configfile.module.json
        gitconfig
scripts/          scripts, run with configfile scripts run <name>, when a module is deployed, or after update and init
    setup.sh
```

A **module** is a folder of `files/` that groups the configuration of one tool. Its `configfile.module.json` lists the module's files: each **entry** names a file of the module, where it goes, and how it's deployed. Scripts in `scripts/` do what files alone can't, such as installing tools: you run them yourself, a module names the ones to [run when it is deployed or undeployed](/guides/module-scripts/), or the repository names the ones to [run after `update` and `init`](/reference/modules/#run-scripts-after-update-and-init). The [modules](/reference/modules/) and [scripts](/reference/scripts/) references describe both folders in detail, and [Your first dotfiles repository](/getting-started/tutorial/) builds one step by step.

## How files are deployed

Each entry says where its file goes, and global entries say how:

- **Global files are copied** into your home folder. You deploy a file once: when `update` brings a new version, it updates the copy, unless the copy changed on this machine.
- **Global files with `"method": "link"` are linked**: `~/.zshrc` becomes a symbolic link to the file in the mirror, which is up to date as soon as `update` has synced the mirror.
- **Local files are copied** into the current folder by `configfile modules deploy --local`. They suit files that belong in each project, such as an `.editorconfig`, and that a project may change. A local copy doesn't follow the repository: deploy it again to refresh it, and *configfile* asks before replacing a copy that differs.

An entry with `"deploy": "none"` stays in the repository without being deployed.

### Changes made on this machine

Many tools write their own configuration: `git config --global`, `mise use -g`, an editor's settings screen, a plugin manager's lockfile. *configfile* records the repository's version each copy holds, so it tells these changes from the repository's:

- a file changed on this machine is **kept**, by `update` and by `modules deploy`, and `modules status` shows it;
- a file changed in the repository, and not here, is updated;
- a file changed on both sides is a **conflict**: `update` leaves it as it is and says so, and `modules deploy` asks whether to replace it with the repository's version (yours is moved to `.old`). Without a terminal, it keeps it and fails, unless you pass `--force`;
- in a copied folder, the files a tool creates (lockfiles, caches, login files) are never touched, unless the repository adds a file at the same place: that is a conflict too.

A change made on this machine stays on this machine: to have it on every machine, make it in your working copy, then commit and push. `update` then finds that the file is the repository's version again. So `update` makes this machine match the remote, **except for the files changed here**, which it keeps and reports. The [modules reference](/reference/modules/#global-files) gives the exact rules.

### Changes made through links

A link leads into the mirror, so whatever writes to a linked file writes to the mirror's file: you, with an editor, or a tool that keeps its own configuration. When a whole folder is linked, the files a tool creates in it, such as caches, lockfiles or login files, land in the mirror too. That is why global files are copied unless an entry asks for a link: use `"method": "link"` for files that nothing rewrites, or that must stay in the repository's folder (scripts that find the repository through their own path, for example).

[`configfile modules status`](/reference/commands/#configfile-modules-status) lists these changes under each link. They are not in the repository, so the next `update` saves them in a patch and puts the repository's version back: a change you want on every machine belongs in your working copy, committed and pushed. Once the remote has it, `update` replaces the mirror's file without saving anything.

To keep files that a tool creates in a linked folder and that don't belong in the repository (caches, logs, login files), list them in the repository's `.gitignore`, in the module's folder or at the root: `update` leaves ignored files where they are.

## Keeping track

*configfile* records each file it deploys, and each file it moves aside, in `~/.configfile/state.json`. That record is what lets it:

- show what is deployed, with [`configfile modules status`](/reference/commands/#configfile-modules-status);
- undo a deployment, with [`configfile modules undeploy`](/reference/commands/#configfile-modules-undeploy), putting back the file it replaced;
- find the files it deployed for entries that have since left the repository, which `update` warns about and `configfile modules undeploy --removed` removes.

It also logs each run of the commands that change things (`init`, `modules deploy` and `undeploy` except dry runs, `update`, `scripts run`) in `~/.configfile/history.jsonl`, along with any command that fails unexpectedly; [`configfile history`](/reference/history/) shows them. [Safety and trust](/concepts/safety/) explains how *configfile* avoids losing or overwriting your files.

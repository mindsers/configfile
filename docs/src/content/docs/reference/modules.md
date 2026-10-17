---
title: Modules and settings.json
description: Module folders, the settings.json format, and how files are deployed and undeployed.
---

Every folder of `files/` (or symbolic link to a folder) that contains a `settings.json` is a **module**. Its name is the folder name, lowercased, with spaces replaced by `-` and other characters than ASCII letters, digits, `_` and `-` removed: `My Zsh.d` is the `my-zshd` module. Hidden folders are ignored.

`settings.json` lists the files of the module:

```json
{
  "files": [
    { "source_path": "zshrc", "target_path": "~/.zshrc", "deploy": "global" },
    { "source_path": "bin", "target_path": "~/.local/bin/mine", "deploy": "global", "method": "link" },
    { "source_path": "editorconfig", "target_path": ".editorconfig", "deploy": "local" },
    { "source_path": "old-aliases", "target_path": "~/.aliases", "deploy": "none" }
  ]
}
```

| Key | Description |
| --- | --- |
| `source_path` | Path of the file (or folder), relative to the module folder. It must stay inside the module folder, symbolic links included. |
| `target_path` | Where the file is deployed. `~` is your home folder. A relative path is relative to your home folder for global files (`.zshrc` is `~/.zshrc`) and to the current folder for local files. Targets can be anywhere you can write, except: your home folder, the current folder, the dotfiles repository, the module folder, *configfile*'s own files (`~/.configfilerc`, `~/.configfile/`), one of their parents, or anything inside the repository. These are recognised whatever the path used to reach them (letter case, symbolic links). |
| `deploy` | Where the file goes. `"global"`: usually into your home folder (a relative `target_path` starts there), with `configfile modules deploy`. `"local"`: into the current folder, typically a project, with `configfile modules deploy --local`. `"none"`: **never deployed**, which keeps it in the repository for later. |
| `method` | How a global file is deployed. `"copy"` (the default): the file is **copied**, and *configfile* keeps the copy up to date with the repository while keeping the changes made on this machine (see [Global files](#global-files)). `"link"`: the file is a **symbolic link** to *configfile*'s copy of the repository, so whatever writes to it writes there ([Changes made through links](/concepts/how-it-works/#changes-made-through-links)). Local files are always copied: `"link"` is an error for them. Copies follow the symbolic links of the source, so they never point into the repository. |

An entry without `deploy` is not deployed, and `modules deploy` warns about it. The `"global": true | false` key of *configfile* 1.x, and a `settings.json` that is a plain list (the format of *configfile* 0.3), are no longer read: [Upgrading from 1.x](/guides/upgrading-from-1/#settings-20-no-longer-reads) says how to update them.

When a global file is deployed and something else already exists at its target (a file, a folder or another link), it is moved to `<target>.old` (or `<target>.old.1`, …). A copy or a link already in place is left as is, so deploying twice is safe.

## Global files

*configfile* records the repository's version it last brought each copy to (a hash of each file), and compares three versions of each file: that one, the file in your home folder, and the repository's current version. For a copied folder, it does so for each file of the folder. Comparing needs git when *configfile*'s copy of the repository is a git repository: when git fails, the copies are not changed, and the command says why.

| The file in your home folder | The repository's version | `modules deploy` and `update` |
| --- | --- | --- |
| is what *configfile* copied | is the same | nothing to do |
| is what *configfile* copied | changed | updated to the repository's version |
| changed on this machine | is the same | **kept**: `modules status` says "changed on this machine" |
| changed on this machine | changed | **conflict**: kept by `update`, which says so; `modules deploy` asks whether to replace it (yours is moved to `.old`): answering no keeps it, and the command still succeeds. Without a terminal, it is kept and the command fails; `--force` replaces it |
| is already the repository's version | changed or not | recorded as up to date |

A file that is already there when a global file is first deployed, even identical to the repository's, is moved to `.old` like any other: `modules undeploy` puts it back. The exception is a file you add to the repository with [`modules adopt`](/reference/commands/#configfile-modules-adopt), or commit in your [working copy](/reference/configuration/) before an `update` brings it: when it is still identical to the repository's version, it stays in place and becomes *configfile*'s copy, with nothing to put back.

With `"method": "link"`, a link that a file replaced (a tool that saves by renaming a new file over it) no longer follows the repository: `modules status` shows it, and `modules deploy` asks before putting the link back, moving the file to `.old`.

- Files that only exist in your home folder, such as the lockfiles or caches a tool creates in a copied folder, are never touched. So are the files of a copied source folder that the repository doesn't track (untracked, or listed in its `.gitignore`): they are copied, but not recorded. If the repository later adds a file at the same place, it is a conflict.
- A file that the repository deleted is deleted from your home folder if it is what *configfile* copied, and is a conflict otherwise. A file you deleted from a copied folder stays deleted, until the repository changes it: it is then a conflict. A whole copied file you deleted is copied again by `modules deploy`.
- `--force` also replaces the files changed on this machine, moving each one to `.old`. In a copied folder, the `.old` file sits next to the one it replaces: a tool that loads every file of the folder (such as `Include config.d/*` in `~/.ssh/config`) loads it too, so delete it once you have checked it.
- A copied file keeps its permissions when it is updated.
- *configfile* compares with the version the repository has: if something changed *configfile*'s copy of the repository itself (an edit made through a link), that change counts as a change made on this machine, never as a change of the repository.
- *configfile* never follows a symbolic link inside a copied folder: a path that leads through a link is left as it is, and the command says why.
- A file written on this machine between the moment *configfile* reads it and the moment it replaces it is kept, as a conflict, even with `--force`. A file the repository's version cannot be written over is put back as it was.
- A copied folder can be updated while it is your current folder; replacing or removing it whole cannot.

Deploying a link entry over a copy *configfile* made, or a copy entry over a link it made, turns one into the other, keeping what the link showed: changes made through a link become changes made on this machine. A copy changed on this machine, or a copied folder holding files *configfile* did not copy (a tool's), is only replaced by a link with `--force`, or after you answer yes: it is moved to `.old` first.

When a local file already exists and differs from the one in the repository, *configfile* asks whether to replace it, once the other files of its module are deployed. The existing file or folder is then moved to `<target>.old` (or `.old.1`, …) before the copy, so nothing is lost.

*configfile* records what it deploys and the backups it makes in `~/.configfile/state.json`. `configfile modules undeploy` reverts a deployment: it removes the links that point to the repository's files, the global copies that did not change on this machine (in a copied folder, each file that did not change; the folder goes once it is empty), and the local copies *configfile* made, as long as a copy is still the file it made and matches the repository's current version, and moves the most recent backup it made back in place, if that backup is unchanged (after a `--force` replaced your changed copy, that is your changed copy). Anything else is left untouched: files it did not create (even when identical to the repository), apart from links to the repository's files, local copies that differ from the repository (changed by you, or because the repository changed since) or were saved again by an editor, and `.old` files you made yourself.

When an entry leaves the repository (removed, set to `"deploy": "none"`, given another `target_path`, or its module deleted), what *configfile* deployed for it stays in place until it is undeployed: `modules status` lists these files, `update` warns about them, and `modules undeploy --removed` (or `--all`) removes them and restores the files they replaced. Local copies are handled from the folder they were copied into, like `modules deploy --local`. A removed file that *configfile* cannot remove safely (replaced by your own file, a modified copy, a local copy whose source is gone) is left where it is, and *configfile* stops tracking it.

To stay safe, *configfile* never undeploys a file when it cannot tell whether the repository still deploys it: files of a module whose `settings.json` cannot be used or has invalid entries, of a module folder that is not usable (a broken symbolic link, a name another folder uses), and entries without a deployment strategy. `modules status` lists them separately. Links deployed by 0.3 and not deployed again since were not recorded, so they are not found either.

`modules deploy` and `modules undeploy` change files one at a time across processes: while one runs, another one (except a dry run) waits for it, saying `Waiting for another configfile (process N) to finish…`, up to 10 seconds, then stops with an error (the lock is `~/.configfile/lock`). Both take the lock for the files of each module in turn, and release it while a [script of the module](#run-scripts-when-a-module-is-deployed-or-undeployed) runs: another deployment can take its turn between two modules, and a deployment that cannot take the lock again stops there, saying which modules were left out. `update` and `init` take the same lock while they change configfile's copy of the repository or its configuration, so files are never deployed from a repository being synced. The modules and their settings are read when the deployment starts, before it takes the lock.

> **Deploying a repository means trusting it**, like code you run: its files end up in your shell configuration, and its scripts run on your machine. Only deploy repositories you trust. [Safety and trust](/concepts/safety/) explains what *configfile* protects, and what it refuses to touch.

## Run scripts when a module is deployed or undeployed

[Run scripts when a module is deployed](/guides/module-scripts/) is a step-by-step guide. Some modules need a step around their files: installing what the configuration needs, installing the plugins it lists, rebuilding a cache, starting a service, and the reverse when the module is removed. Name [scripts](/reference/scripts/) of the repository next to `files`:

```json
{
  "files": [
    { "source_path": "tmux.conf", "target_path": "~/.tmux.conf", "deploy": "global" }
  ],
  "post_deploy": "tmux-plugins",
  "pre_undeploy": "tmux-plugins-remove"
}
```

| Setting | The script runs |
| --- | --- |
| `pre_deploy` | before `modules deploy` deploys the files of the module |
| `post_deploy` | once `modules deploy` has deployed all of them |
| `pre_undeploy` | before `modules undeploy` removes the files of the module, while they are still in place |
| `post_undeploy` | once `modules undeploy` has removed them |

Each one is a script's name, as `configfile scripts list` shows it: here `scripts/tmux-plugins.sh`, or `scripts/tmux-plugins.macos.sh` on macOS. It is run the way `configfile scripts run tmux-plugins` runs it (same interpreters, in the current folder, with the same variables), without arguments, and also gets the setting's name in `CONFIGFILE_HOOK`, the module's name in `CONFIGFILE_MODULE` and `global` or `local` in `CONFIGFILE_DEPLOY`.

`modules deploy` and `modules undeploy` work on one module at a time, in the order of `modules list`: the `pre_` script of a module, its files, its `post_` script, then the next module.

- The scripts run **every time** the module is deployed or undeployed, including when its files were already up to date or not deployed, so write them to be safe to run again.
- They only run when the module has files of the kind the command works on (local files with `--local`, global files otherwise). When you name such a module on the command line, the command says, with a warning, that its script was not run.
- When a `pre_` script fails, the files of the module are **left as they are** (not deployed, or still deployed) and its `post_` script is not run.
- The `post_deploy` script only runs when all the files of the module are in place. When a file fails or is skipped, or an entry is invalid, it is not run, with a warning. In the same way, the `post_undeploy` script is not run when a file could not be undeployed; a file that `undeploy` keeps on purpose (a copy you modified, a file it did not create) does not prevent it.
- When a script fails (it exits with an error or cannot be started), the modules after it are **left as they are** and the command fails. What was already done stays done. `--keep-going` goes on with the remaining modules anyway; the command still fails. It exits with `1`, not with the script's exit code, which is in the [history](/reference/history/).
- A name that matches no script is found **before anything is changed**: the command names every such script and fails. With `--keep-going`, it starts anyway, and the script fails when its turn comes.
- A script that only has versions for other systems (`tmux-plugins.macos.sh` alone, on Linux) is not a mistake: it is skipped, the command says so, and the module is deployed or undeployed as if it named no script.
- Ctrl+C while a script runs is left to the script, as with `scripts run`; once it ends, the command stops there, with or without `--keep-going`, and exits with `130`.
- `--no-hooks` deploys or undeploys the files without running any script.
- `--dry-run` shows the scripts that would run, and those that would not because a file would fail or be skipped, or an entry is invalid, without running them. It fails like the real command when a script does not exist.
- A setting that is not a script name (not text, or empty) is ignored: no script runs for it. The command it belongs to reports it as an error and fails, once the files are deployed or undeployed, even with `--no-hooks` (`modules deploy` for `pre_deploy` and `post_deploy`, `modules undeploy` for the other two). The other one only warns about it; `modules list` and `status` show it as an error.
- `modules list` names the settings a module uses, and `modules status` shows the scripts, and says when one does not exist.

No script runs for the files the repository no longer deploys (`modules undeploy --removed`, or `--all`): their module or entry is gone, with its settings. With `--all`, they are undeployed after the modules; when a script stops the command before that, they are left in place, and the command says so.

## Completion and validation in your editor

A [JSON Schema](https://docs.configfile.sh/schemas/settings.json) describes `settings.json`. Add it at the top of the file, and editors that support JSON Schema (VS Code, Zed, JetBrains IDEs, and others) suggest the keys and their values, show their descriptions, and flag mistakes as you type:

```json
{
  "$schema": "https://docs.configfile.sh/schemas/settings.json",
  "files": []
}
```

*configfile* ignores the `$schema` key. The schema checks the structure of the file; the rules about where paths may point are checked by *configfile* when it reads the module. It is also stricter, to catch typos: it flags keys *configfile* doesn't know (such as `target-path`), which *configfile* ignores.


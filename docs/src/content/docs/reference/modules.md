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
    { "source_path": "editorconfig", "target_path": ".editorconfig", "deploy": "local" },
    { "source_path": "old-aliases", "target_path": "~/.aliases", "deploy": "none" }
  ]
}
```

| Key | Description |
| --- | --- |
| `source_path` | Path of the file (or folder), relative to the module folder. It must stay inside the module folder, symbolic links included. |
| `target_path` | Where the file is deployed. `~` is your home folder. A relative path is relative to your home folder for global files (`.zshrc` is `~/.zshrc`) and to the current folder for local files. Targets can be anywhere you can write, except: your home folder, the current folder, the dotfiles repository, the module folder, *configfile*'s own files (`~/.configfilerc`, `~/.configfile/`), one of their parents, or anything inside the repository. These are recognised whatever the path used to reach them (letter case, symbolic links). |
| `deploy` | `"global"`: the file is **symlinked** by `configfile modules deploy`. `"local"`: the file is **copied** by `configfile modules deploy --local`, typically into a project folder (symbolic links in the source are followed, so the copy never points into the repository). `"none"`: the file is **never deployed**, which keeps it in the repository for later. |
| `global` | **Deprecated**, removed in 2.0: older spelling of `deploy`. `true` is `"global"`, `false` is `"local"`. It still works in 1.x, with a warning. Use one or the other, not both. |

An entry without `deploy` or `global` is not deployed, and `modules deploy` warns about it.

When a global file is deployed and something else already exists at its target (a file, a folder or another link), it is moved to `<target>.old` (or `<target>.old.1`, …). A link that already points to the right file is left as is, so deploying twice is safe.

When a local file already exists and differs from the one in the repository, *configfile* asks whether to replace it, once the other files of its module are deployed. The existing file or folder is then moved to `<target>.old` (or `.old.1`, …) before the copy, so nothing is lost.

*configfile* records what it deploys and the backups it makes in `~/.configfile/state.json`. `configfile modules undeploy` reverts a deployment: it removes the links that point to the repository's files and the local copies *configfile* made, as long as a copy is still the file it made and matches the repository's current version, and moves the most recent backup it made back in place, if that backup is unchanged. Anything else is left untouched: files it did not create (even when identical to the repository), apart from links to the repository's files, local copies that differ from the repository (changed by you, or because the repository changed since) or were saved again by an editor, and `.old` files you made yourself.

When an entry leaves the repository (removed, set to `"deploy": "none"`, given another `target_path`, or its module deleted), what *configfile* deployed for it stays in place until it is undeployed: `modules status` lists these files, `update` warns about them, and `modules undeploy --removed` (or `--all`) removes them and restores the files they replaced. Local copies are handled from the folder they were copied into, like `modules deploy --local`. A removed file that *configfile* cannot remove safely (replaced by your own file, a modified copy, a copy whose source is gone) is left where it is, and *configfile* stops tracking it.

To stay safe, *configfile* never undeploys a file when it cannot tell whether the repository still deploys it: files of a module whose `settings.json` cannot be used or has invalid entries, of a module folder that is not usable (a broken symbolic link, a name another folder uses), and entries without a deployment strategy. `modules status` lists them separately. Links deployed by 0.3 and not deployed again since were not recorded, so they are not found either.

`modules deploy` and `modules undeploy` change files one at a time across processes: while one runs, another one (except a dry run) waits for it, up to 10 seconds, then stops with an error (the lock is `~/.configfile/lock`). Both take the lock for the files of each module in turn, and release it while a [script of the module](#run-scripts-when-a-module-is-deployed-or-undeployed) runs: another deployment can take its turn between two modules, and a deployment that cannot take the lock again stops there, saying which modules were left out. `update` and `init` take the same lock while they change configfile's copy of the repository or its configuration, so a deployment never reads files they are replacing.

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

No script runs for the files the repository no longer deploys (`modules undeploy --removed`, or `--all`): their module or entry is gone, with its settings. With `--all`, they are undeployed after the modules; when a script stops the command before that, they are left in place, and the command says so. A `settings.json` in the 0.3 list format cannot have these keys.

## Completion and validation in your editor

A [JSON Schema](https://docs.configfile.sh/schemas/settings.json) describes `settings.json`. Add it at the top of the file, and editors that support JSON Schema (VS Code, Zed, JetBrains IDEs, and others) suggest the keys and their values, show their descriptions, and flag mistakes as you type:

```json
{
  "$schema": "https://docs.configfile.sh/schemas/settings.json",
  "files": []
}
```

*configfile* ignores the `$schema` key. The schema checks the structure of the file; the rules about where paths may point are checked by *configfile* when it reads the module. It is also stricter, to catch typos: it flags keys *configfile* doesn't know (such as `target-path`), which *configfile* ignores.


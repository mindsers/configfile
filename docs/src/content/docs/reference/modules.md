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

When a local file already exists and differs from the one in the repository, *configfile* asks whether to replace it, once the other files are deployed. The existing file or folder is then moved to `<target>.old` (or `.old.1`, …) before the copy, so nothing is lost.

*configfile* records what it deploys and the backups it makes in `~/.configfile/state.json`. `configfile modules undeploy` reverts a deployment: it removes the links that point to the repository's files and the local copies *configfile* made, as long as a copy is still the file it made and matches the repository's current version, and moves the most recent backup it made back in place, if that backup is unchanged. Anything else is left untouched: files it did not create (even when identical to the repository), apart from links to the repository's files, local copies that differ from the repository (changed by you, or because the repository changed since) or were saved again by an editor, and `.old` files you made yourself.

When an entry leaves the repository (removed, set to `"deploy": "none"`, given another `target_path`, or its module deleted), what *configfile* deployed for it stays in place until it is undeployed: `modules status` lists these files, `update` warns about them, and `modules undeploy --removed` (or `--all`) removes them and restores the files they replaced. Local copies are handled from the folder they were copied into, like `modules deploy --local`. A removed file that *configfile* cannot remove safely (replaced by your own file, a modified copy, a copy whose source is gone) is left where it is, and *configfile* stops tracking it.

To stay safe, *configfile* never undeploys a file when it cannot tell whether the repository still deploys it: files of a module whose `settings.json` cannot be used or has invalid entries, of a module folder that is not usable (a broken symbolic link, a name another folder uses), and entries without a deployment strategy. `modules status` lists them separately. Links deployed by 0.3 and not deployed again since were not recorded, so they are not found either.

`modules deploy` and `modules undeploy` change files one at a time across processes: while one runs, another one (except a dry run) waits for it, up to 10 seconds, then stops with an error (the lock is `~/.configfile/lock`). Other commands, such as `update`, don't wait for it.

> **Deploying a repository means trusting it**, like code you run: its files end up in your shell configuration, and its scripts run on your machine. Only deploy repositories you trust. [Safety and trust](/concepts/safety/) explains what *configfile* protects, and what it refuses to touch.

## Completion and validation in your editor

A [JSON Schema](https://docs.configfile.sh/schemas/settings.json) describes `settings.json`. Add it at the top of the file, and editors that support JSON Schema (VS Code, Zed, JetBrains IDEs, and others) suggest the keys and their values, show their descriptions, and flag mistakes as you type:

```json
{
  "$schema": "https://docs.configfile.sh/schemas/settings.json",
  "files": []
}
```

*configfile* ignores the `$schema` key. The schema checks the structure of the file; the rules about where paths may point are checked by *configfile* when it reads the module. It is also stricter, to catch typos: it flags keys *configfile* doesn't know (such as `target-path`), which *configfile* ignores.


---
title: Run scripts when a module is deployed
description: Install plugins, rebuild a cache or start a service each time a module is deployed, and clean up when it is undeployed.
sidebar:
  order: 3
---

Linking a configuration file is often half of the job: tmux needs its plugins installed, `mise` needs to install the tools its configuration lists, a font cache needs rebuilding. A module can name scripts for these steps, and *configfile* runs them when it deploys or undeploys the module. This guide sets one up for tmux; the [modules reference](/reference/modules/#run-scripts-when-a-module-is-deployed-or-undeployed) has every rule.

## 1. Write the script

Scripts go in `scripts/`, like the ones you run with `configfile scripts run`. This one installs the tmux plugin manager, then the plugins listed in `~/.tmux.conf`:

```sh title="scripts/tmux-plugins.sh"
#!/bin/sh
set -e

tpm="$HOME/.tmux/plugins/tpm"
[ -d "$tpm" ] || git clone https://github.com/tmux-plugins/tpm "$tpm"
"$tpm/bin/install_plugins"
```

The script runs **every time** the module is deployed, so it must be safe to run again: here it only clones the plugin manager when it isn't there yet.

## 2. Name it in the module

In the module's `settings.json`, next to `files`:

```json title="files/tmux/settings.json" {5}
{
  "files": [
    { "source_path": "tmux.conf", "target_path": "~/.tmux.conf", "deploy": "global" }
  ],
  "post_deploy": "tmux-plugins"
}
```

`post_deploy` is the script's name, as `configfile scripts list` shows it, not its path. Push the change and run `configfile update`, as for any change to your dotfiles.

## 3. Check, then deploy

`modules status` shows the scripts of each module, and says when a name matches no script:

```txt
$ configfile modules status tmux
tmux:
  ~/.tmux.conf (not deployed)
  post_deploy: script "tmux-plugins"
```

A dry run shows when the script would run, without running it:

```txt
$ configfile modules deploy --all --dry-run
 Info  Dry run, nothing is changed. Deploying tmux, zsh would do:
- ~/.tmux.conf (would be linked)
- script "tmux-plugins" (post_deploy of tmux: would run)
- ~/.zshrc (would be linked)
 Done  Dry run finished.
```

Then deploy. Modules are deployed one at a time: the files of `tmux`, its script, then `zsh`.

```txt
$ configfile modules deploy --all
 Info  Deploying tmux, zsh…
- ~/.tmux.conf (deployed)
 Info  Running "tmux-plugins", the post_deploy script of tmux…
- ~/.zshrc (deployed)
 Done  Deployment finished.
```

The output of the script appears where it runs. `configfile modules deploy tmux` alone now leaves the module fully set up, and you can still run the script by hand with `configfile scripts run tmux-plugins`.

## When a script fails

When the script exits with an error, the command stops there and fails: the modules after it are not deployed. What is already deployed stays in place.

```txt
 Error  tmux: post_deploy script "tmux-plugins" exited with code 1.
 Error  The post_deploy script of tmux failed. 1 module was not deployed: zsh. Use --keep-going to go on after a script that fails.
```

Fix the cause and deploy again: files already in place are left as they are, and the script runs again. To deploy the other modules anyway, pass `--keep-going`; the command still fails, so a bootstrap script notices. To deploy the files without running any script, pass `--no-hooks`.

## Clean up when the module is undeployed

`configfile modules undeploy tmux` removes the link, not what the script installed. Name a second script for that:

```sh title="scripts/tmux-plugins-remove.sh"
#!/bin/sh
rm -rf "$HOME/.tmux/plugins"
```

```json title="files/tmux/settings.json" {6}
{
  "files": [
    { "source_path": "tmux.conf", "target_path": "~/.tmux.conf", "deploy": "global" }
  ],
  "post_deploy": "tmux-plugins",
  "pre_undeploy": "tmux-plugins-remove"
}
```

## Which setting to use

| Setting | The script runs | Typical use |
| --- | --- | --- |
| `pre_deploy` | before the files are deployed | install the tool the configuration is for; when the script fails, the module is not deployed |
| `post_deploy` | once all the files are in place | install plugins, rebuild a cache, start or reload a service |
| `pre_undeploy` | before the files are removed, while they are still in place | stop a service, remove what `post_deploy` installed; when the script fails, the module stays deployed |
| `post_undeploy` | once the files are removed | reload a tool that now uses its defaults |

## Good to know

- **One script for several settings or modules.** A script gets the setting that named it in `CONFIGFILE_HOOK`, the module in `CONFIGFILE_MODULE`, and `global` or `local` in `CONFIGFILE_DEPLOY`, in addition to the [variables every script gets](/reference/scripts/).
- **Local files.** `configfile modules deploy --local` runs the scripts too, in the project folder, for the modules that have local files. A script that only makes sense once per machine can leave early: `[ "$CONFIGFILE_DEPLOY" = global ] || exit 0`.
- **Versions per system.** As for any script, `tmux-plugins.macos.sh` is used on macOS instead of `tmux-plugins.sh`.
- **Scripts that run configfile.** They can: no deployment is in progress while a script runs.
- **Trust.** These scripts run without a question, as part of `modules deploy` and `modules undeploy`. Read the scripts of a repository that isn't yours before deploying it, or use `--dry-run` to see which ones would run. See [Safety and trust](/concepts/safety/).

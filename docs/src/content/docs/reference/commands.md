---
title: Commands
description: Every configfile command and option, exit codes, and use without a terminal.
---

Every command prints its own help with `--help`, and most have a short form, shown under their usage. The usage lines and the tables of arguments and options below are generated from *configfile* itself.

## `configfile init`

Asks for the URL of your dotfiles repository (any URL git can clone, such as `https://github.com/me/dotfiles.git` or `git@github.com:me/dotfiles.git`, or an existing local folder), clones it into `~/.configfile/dotfiles` and saves the configuration in `~/.configfilerc`. If the folder already contains a git repository, it is used as is. When you run `init` again, the existing folder is kept. After the URL question, it waits for a deployment or `update` in progress, saying `Waiting for another configfile (process N) to finish…`, up to 10 seconds; it then checks the folder and the configuration again: it reuses a repository another configfile cloned meanwhile, and stops if another configfile saved a configuration meanwhile (unless `--force`). `--working-copy` saves where your own clone of the repository is, for [`modules adopt`](#configfile-modules-adopt) and [`update`](#configfile-update). `--profile` (repeatable) saves this machine's [profiles](/reference/modules/#deploy-on-some-machines-only), with a warning for a name no module uses. Without it, when the repository's modules name profiles, `init` asks for them in a terminal once the repository is cloned, and refuses names no module uses; without a terminal, it says which profiles the modules name. Once the configuration is saved, it runs the [`post_init` script](/reference/modules/#run-scripts-after-update-and-init) the repository names: in a terminal, it asks first; without one, only with `--hooks`. `--no-hooks` never runs it.

When the repository is empty (it has no commit yet, such as a repository just created on GitHub), `init` offers to set it up, before the `post_init` script. In a terminal, it asks first, then where your working copy goes (`~/dotfiles` by default; `--working-copy` skips this question). Without a terminal, it only says the repository is empty, unless `--new-repository` is given; `--no-new-repository` never sets it up. The working copy is cloned from the repository when the folder is missing or empty; an existing clone of the repository is used when it has no commit yet and none of the files below. In it, `init` writes `configfile.repository.json`, a `README.md`, an example module (`files/example`, whose file is never deployed) and an example script (`scripts/hello.sh`), commits them with your git identity on the branch configfile follows, pushes them, syncs its own copy and saves `working_copy` in `~/.configfilerc`. It never pushes from its own copy. When git doesn't know your name and email, it stops before writing anything; when the commit or the push fails, the files stay in your working copy and `init` says how to finish.

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
| `--working-copy <path>` | your own clone of the repository, where "modules adopt" commits and from which "update" pushes |
| `--profile <name>` | a profile of this machine, which "when" conditions of the modules name (repeatable; skips the question) |
| `--hooks` | run the post_init script of the repository without asking |
| `--no-hooks` | do not run the post_init script of the repository |
| `--new-repository` | when the repository is empty, set it up in your working copy without asking: commit starter files, and push them |
| `--no-new-repository` | when the repository is empty, do not offer to set it up |
<!-- /generated -->

## `configfile modules list`

Lists the available modules. `configfile modules` alone does the same.

<!-- generated: configfile modules list -->
```sh
configfile modules list
```

Short form: `configfile m l`.
<!-- /generated -->

## `configfile modules status`

Shows whether each global file of the modules (all modules by default) is copied, linked, not deployed, or blocked by another file, and the scripts each module runs when it is deployed or undeployed. Without module names, it also lists the deployed files the repository no longer deploys. Modules that are not for this machine ([`when`](/reference/modules/#deploy-on-some-machines-only)) are summed up in one line, unless they are named; files that are not for it are listed with the reason. It warns about a profile of this machine that no module uses. `--os` and `--profile` (repeatable) check as if this machine ran that system and had those profiles instead of its own, for this run only. Without module names, it also lists the scripts the repository runs after `update` and `init`, even when it finds no module.

For a copy, it says when it changed on this machine, when the repository has a newer version (or no longer has a file), and when both changed; for a copied folder, it lists the files concerned under it. When some files cannot be checked, it shows the others, then fails with exit code 1.

A file in the way of a global file that was never deployed is shown with whether it is identical to the repository's version or differs from it. A link that a file replaced (a tool that saves by writing a new file and renaming it over the link, such as `sed -i`) shows as `linked, but a file replaced the link`, with the same comparison: the repository's changes no longer reach it.

Under a deployed link, it lists the changes made through it in *configfile*'s copy of the repository, by you or by a tool that writes its own configuration: files changed or deleted through the link, and new files a tool created in a linked folder. The next `update` saves them in a patch and puts the repository's version back, so bring the ones you want to keep into your working copy first ([Changes made through links](/concepts/how-it-works/#changes-made-through-links)). This needs git; without it, `status` says that these changes cannot be checked.

<!-- generated: configfile modules status -->
```sh
configfile modules status [options] [modules...]
```

Short form: `configfile m st`.

| Argument or option | Description |
| --- | --- |
| `modules` | modules to check (all when omitted) |
| `-l, --local` | check the local files of the modules, in the current folder |
| `--os <system>` | check as if this machine ran this system (macos or linux) |
| `--profile <name>` | check as if this machine had this profile instead of its own (repeatable) |
<!-- /generated -->

## `configfile modules deploy`

Deploys the global files of the given modules (copies, or links with `"method": "link"`), one module at a time, and runs the [`pre_deploy` and `post_deploy` scripts](/reference/modules/#run-scripts-when-a-module-is-deployed-or-undeployed) of the modules that have them. Without module names, asks to deploy all modules. Modules that are not for this machine ([`when`](/reference/modules/#deploy-on-some-machines-only)) are skipped with a message, even when they are named, and their scripts don't run; files that are not for it are skipped, with one line per module (`--dry-run` lists them one by one). The command still succeeds. With `--dry-run`, `--os` and `--profile` (repeatable) show what a machine running that system with those profiles would get, scripts included; without `--dry-run`, they are refused.

A copy already deployed follows the repository where nothing changed it on this machine ([Global files](/reference/modules/#global-files)). For a file changed both on this machine and in the repository, it asks whether to replace it with the repository's version, once the other files of the module are deployed; answering no keeps yours, and the command still succeeds. Without a terminal, it keeps yours and fails; `--force` replaces it, and also the files changed on this machine, moving each one to `.old`. Files it could not update (reached through a link inside the copy, or written while it ran) make the command fail, with the reason.

For an entry with `"method": "link"` whose link a file replaced, it asks whether to put the link back, moving the file to `.old`; answering no keeps the file, and the command still succeeds. Without a terminal, it keeps the file and fails; `--force` puts the link back.

<!-- generated: configfile modules deploy -->
```sh
configfile modules deploy [options] [modules...]
```

Short form: `configfile m d`.

| Argument or option | Description |
| --- | --- |
| `modules` | modules to deploy (use --all, or answer a question, when omitted) |
| `-l, --local` | copy the local files of the modules into the current folder, instead of the global files |
| `-a, --all` | deploy every module without asking |
| `-f, --force` | replace existing local files, and copies changed on this machine, without asking (they are moved to .old) |
| `-n, --dry-run` | show what would be done, without changing anything |
| `--os <system>` | with --dry-run: as if this machine ran this system (macos or linux) |
| `--profile <name>` | with --dry-run: as if this machine had this profile instead of its own (repeatable) |
| `--no-hooks` | do not run the pre_deploy and post_deploy scripts of the modules |
| `--keep-going` | deploy the remaining modules when a pre_deploy or post_deploy script fails |
<!-- /generated -->

## `configfile modules undeploy`

Removes the deployed global files of the given modules and restores their backups, one module at a time, and runs the [`pre_undeploy` and `post_undeploy` scripts](/reference/modules/#run-scripts-when-a-module-is-deployed-or-undeployed) of the modules that have them. Without module names, asks to undeploy all modules. `--local` and `--dry-run` work as for `deploy`. [Modules](/reference/modules/) explains which files `--removed` covers; with `--local`, it covers the copies made in the current folder. A named module that is no longer for this machine has the files deployed for it removed, without its scripts.

<!-- generated: configfile modules undeploy -->
```sh
configfile modules undeploy [options] [modules...]
```

Short form: `configfile m u`.

| Argument or option | Description |
| --- | --- |
| `modules` | modules to undeploy (use --all, or answer a question, when omitted) |
| `-l, --local` | remove the local copies of the modules instead of the global files |
| `-a, --all` | undeploy every module without asking, and the files the repository no longer deploys |
| `--removed` | only undeploy the files the repository no longer deploys |
| `-n, --dry-run` | show what would be done, without changing anything |
| `--no-hooks` | do not run the pre_undeploy and post_undeploy scripts of the modules |
| `--keep-going` | undeploy the remaining modules when a pre_undeploy or post_undeploy script fails |
<!-- /generated -->

## `configfile modules adopt`

Adds files or folders of this machine to a module of your repository, so that you don't have to copy them into it by hand. It works in your own working copy of the repository (never in *configfile*'s copy, which `update` resets), given with `--into` the first time and then remembered as [`working_copy`](/reference/configuration/):

1. it checks that the working copy is a clone of your dotfiles repository, on the branch *configfile* follows, with no uncommitted changes (untracked files included: commit, stash or remove them first); it fetches, and brings the branch up to date when it is behind (it stops when the branch has diverged; `--dry-run` doesn't fetch);
2. it copies each file or folder into the module's folder (created, with its `configfile.module.json`, when the module doesn't exist), named after it without its leading dot (`~/.zshrc` becomes `zshrc`, or the name given with `--as`), and adds an entry `{ "source_path": "zshrc", "target_path": "~/.zshrc", "deploy": "global" }` at the end of its `configfile.module.json`, keeping the rest of the file as written;
3. it commits them, with your identity and hooks, as `Adopt ~/.zshrc` (or `--message`), and pushes;
4. it syncs *configfile*'s copy, like `update`, and keeps each file as *configfile*'s copy: the file stays where it is, unchanged, and follows the repository from then on ([Global files](/reference/modules/#global-files)).

`--os` and `--profile` (repeatable) say which machines the files are for, as [`when`](/reference/modules/#deploy-on-some-machines-only): on the module adopt creates, or on the entries it adds to an existing one. They must include this machine, where the files come from; adopt also refuses a module that is not for this machine. It stops while a module of the working copy cannot be used, since it cannot check that this module doesn't deploy these files already. It never adopts a symbolic link, a file *configfile* already deploys or another module deploys (or a file inside one of them, or a folder holding one), a file your repository's `.gitignore` excludes, a folder holding a git repository, or anything inside or holding your working copy or *configfile*'s folders. It doesn't look for secrets in what it commits: encrypt what needs to be before adopting it. If anything fails before the commit, what it wrote is removed. If the push fails, the commit stays in your working copy, and nothing else changes: push it, or run `update`, which pushes it. With `--no-push`, it stops after the commit, and the next `update` pushes it and keeps the files as copies. Undeploying an adopted file works as for any copy: it is removed only when unchanged, and the module can be deployed again on another machine.

<!-- generated: configfile modules adopt -->
```sh
configfile modules adopt [options] <paths...>
```

Short form: `configfile m adopt`.

| Argument or option | Description |
| --- | --- |
| `paths` | files or folders of this machine to add to the module |
| `-m, --module <name>` | the module to add them to (created when missing) |
| `--into <folder>` | your working copy of the dotfiles repository (remembered) |
| `--as <name>` | the name of the file in the module (one path only) |
| `--message <text>` | the commit message |
| `--no-push` | commit without pushing ("configfile update" pushes it later) |
| `--os <system>` | the files are only for this system (macos or linux): written as "when" in the module's settings |
| `--profile <name>` | the files are only for machines with this profile (repeatable): written as "when" |
| `-n, --dry-run` | show what would be done, without changing anything |
<!-- /generated -->

## `configfile scripts list`

Lists the available scripts. `configfile scripts` alone does the same.

<!-- generated: configfile scripts list -->
```sh
configfile scripts list
```

Short form: `configfile s l`.
<!-- /generated -->

## `configfile scripts run`

Runs a script. Arguments after `--` are passed to the script.

<!-- generated: configfile scripts run -->
```sh
configfile scripts run <name> [args...]
```

Short form: `configfile s r`.

| Argument or option | Description |
| --- | --- |
| `name` | script to run |
| `args` | arguments passed to the script (put them after "--") |
<!-- /generated -->

## `configfile update`

When a [working copy](/reference/configuration/) is configured, it first pushes the commits of the followed branch that the remote doesn't have (a failed push, or a branch that diverged from the remote, only gets a warning). Once synced, it keeps as *configfile*'s copies the files that the commits of your working copy's branch (committed or pulled there) added to a module, among those the sync brought, when they are already identical to the repository's version, whether `update` or you pushed them: this is how `modules adopt --no-push` ends. Files that commits pushed from elsewhere add are deployed as usual, with `modules deploy`. A file it doesn't keep, because it differs from the repository's version, is left as it is, with a warning.

Syncs *configfile*'s copy of your dotfiles repository with the remote: it fetches the remote and makes the copy identical to it, whatever happened to the copy. Local changes found in the copy (uncommitted edits, new files or unpushed commits, for example edits made through a deployed link) that the remote doesn't have are first saved as a patch in `~/.configfile/saved/`, and `update` names the files they change; to keep them, apply the patch in your own working copy with `git -C <your working copy> apply --3way <patch>` (or `git am <patch>`), then commit and push. Changes the remote already has, because you pushed them from your working copy, are not saved. Then it updates the global files copied from the repository, where the repository changed them and this machine did not: files changed on this machine are kept, and files changed on both sides are left as they are, with a warning that says to run `modules deploy` ([Global files](/reference/modules/#global-files)). It never moves a file aside, asks a question or runs a module's scripts, and a file it cannot update only gets a warning. Global files deployed as links are up to date as soon as the copy of the repository is; `update` names the global files the repository copies that are still links from an older deployment. Run `modules deploy --all` for new files, and `modules deploy --local` to refresh local copies. It warns about deployed files the repository no longer deploys, and, apart, about those no longer for this machine (check `"profiles"` in `~/.configfilerc`). It waits for a deployment or `init` in progress, saying `Waiting for another configfile (process N) to finish…`, up to 10 seconds, and deployments started during the sync wait for it, up to 10 seconds: a slow fetch can make them fail. Last, when the sync brought changes, it runs the [`post_update` script](/reference/modules/#run-scripts-after-update-and-init) the repository names, unless `--no-hooks` is given: when the script is missing or fails, `update` exits with 1, the sync being done.

<!-- generated: configfile update -->
```sh
configfile update [options]
```

Short form: `configfile u`.

| Argument or option | Description |
| --- | --- |
| `--no-hooks` | do not run the post_update script of the repository |
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

*configfile* exits with a non-zero code when a command fails, and with the script's exit code when a script run with `scripts run` fails, so it can be used from other scripts (a script named by a module that fails makes `modules deploy` or `undeploy` exit with `1`). When stdin is not a terminal, a command that would ask a question fails and names the option to pass instead (`--repo`, `--folder` and `--force` for `init`; module names or `--all` for `modules deploy` and `undeploy`). Without a terminal, `modules deploy --local` skips existing local files and exits with an error, unless `--force` is given. Ctrl+C at a question, or while a script named by a module runs, exits with code 130. Each run of a command that changes files, and any unexpected error, is also recorded in the [history](/reference/history/).

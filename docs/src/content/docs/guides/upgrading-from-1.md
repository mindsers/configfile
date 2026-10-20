---
title: Upgrading from 1.x
description: Global files are copied instead of linked in configfile 2.0. What changes, and how to move your machines over.
sidebar:
  order: 4
---

*configfile* 2.0 copies global files into your home folder instead of linking them, unless an entry asks for a link with `"method": "link"`. Your repository needs no change, unless it still uses the settings deprecated in 1.x ([Settings 2.0 no longer reads](#settings-20-no-longer-reads)).

## Why

A link leads into *configfile*'s copy of your repository, so the tools that write their own configuration (`git config --global`, `mise use -g`, an editor's settings screen, a plugin manager's lockfile) wrote into it, and `configfile update` then put the repository's version back, saving their changes in a patch. Files they created in a linked folder were removed the same way.

A copy is yours: *configfile* records what it copied, updates the copy when the repository changes and nothing changed it on this machine, and keeps it otherwise. [Changes made on this machine](/concepts/how-it-works/#changes-made-on-this-machine) explains it, and the [modules reference](/reference/modules/#global-files) gives the exact rules.

## Move a machine to copies

1. Install 2.0, as described in [Installation](/getting-started/installation/).
2. Run `configfile modules status`. The global files deployed by 1.x are still links, and say `linked: deploy it again to copy it`.
3. Run `configfile modules deploy --all`, **before your next `update`**. Each link becomes a copy of what it showed, `(copied in place of configfile's link)`: the changes your tools made through the link are kept, and `modules status` shows them as changed on this machine.
4. Run `configfile update`. It may still save a patch of the changes your tools made through the old links, as 1.x did: they were in *configfile*'s copy of the repository. Your copies keep these changes, so the patch is only a record of them.

Until you deploy again, links keep working as in 1.x, and `update` reminds you of the global files that are still links.

To bring a change made on this machine to your other machines, make it in your working copy, then commit and push: `update` then finds that the copy is the repository's version again.

## Rename the settings of your modules

*configfile* 2.0 reads the settings of a module from `configfile.module.json`, so that a module can deploy an app's own `settings.json`. In your working copy, rename the `settings.json` of each module, then commit and push:

```sh
for file in files/*/settings.json; do git mv "$file" "${file%settings.json}configfile.module.json"; done
```

To keep `settings.json` instead, add `configfile.repository.json` at the root of the repository, with `{ "module_settings": "settings.json" }` ([Repository settings](/reference/modules/#repository-settings)). Until you do either, *configfile* 2.0 doesn't use them: it says how to rename each `settings.json` that has a `"files"` list, and warns about any other one (invalid JSON, for example), which it cannot read. For a module folder that is a symbolic link, rename the file where the link points. Rename after upgrading every machine: *configfile* 1.x only reads `settings.json`.

## Settings 2.0 no longer reads

Two older spellings, deprecated since 1.0, are gone. *configfile* says so, and leaves the files they describe as they are, until the settings are updated:

- `"global": true` and `"global": false` in an entry: write `"deploy": "global"` and `"deploy": "local"` instead. An entry that still has `"global"` is invalid: it is not deployed, and the command fails.
- Settings that are a plain list (the format of *configfile* 0.3): put the list in a `"files"` key, `{ "files": [ ... ] }`. Until then, the module cannot be used.

## Keep a link

Add `"method": "link"` to the entries that should stay links, then deploy them again:

```json
{ "source_path": "bin", "target_path": "~/.local/bin/mine", "deploy": "global", "method": "link" }
```

Links suit files that nothing but you rewrites, and files that must stay in the repository's folder, such as scripts that find the repository through their own path. [Changes made through links](/concepts/how-it-works/#changes-made-through-links) explains what happens when something writes to one.

## What else changes

- `modules status` says `copied` or `linked` for global files, instead of `deployed`, and lists the files of a copy that changed on this machine, in the repository, or on both sides.
- `modules deploy` says `(copied)` or `(linked)`. A file changed both on this machine and in the repository is a conflict: `modules deploy` asks whether to replace it with the repository's version (yours is moved to `.old`); answering no keeps it. Without a terminal, it keeps it and the command fails; `--force` replaces it. `--force` also replaces the files changed on this machine.
- `modules status` exits with 1 when it cannot check some files, after showing all of them.
- `update` writes in your home folder: it updates *configfile*'s copies the repository changed, and nothing else. It never moves a file aside, asks a question or runs a module's scripts ([What update changes in your home folder](/concepts/safety/#what-update-changes-in-your-home-folder)).
- `modules undeploy` removes a copy only when it did not change on this machine. In a copied folder, it removes the files that did not change, and keeps the rest.
- The history has `updated` lines for the files `update` and `modules deploy` updated, and `kept` lines for the files changed on this machine.

## Going back to 1.x

1.x does not know copies. Before going back, set `"method": "link"` on your global entries and run `configfile modules deploy --all` with 2.0: it turns the copies back into links (a copy changed on this machine, or a copied folder holding files a tool created, needs `--force` or a yes, and is kept as `.old`). 1.x still reads `~/.configfile/state.json`, but takes a copy for a file in the way, and its `modules undeploy --removed` can remove a copy whose source left the repository, even one changed on this machine.

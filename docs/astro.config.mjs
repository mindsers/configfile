// The documentation site, published at https://docs.configfile.sh.
// Everything specific to configfile is in this file; the pages are in
// src/content/docs/, one folder per section listed in `sidebar` below.
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://docs.configfile.sh',
  integrations: [
    starlight({
      title: 'configfile',
      description:
        'Manage your dotfiles and setup scripts from a git repository, on macOS and Linux.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/mindsers/configfile' }],
      // Changes are proposed against develop, as for any other change (git-flow).
      editLink: {
        baseUrl: 'https://github.com/mindsers/configfile/edit/develop/docs/',
      },
      lastUpdated: true,
      sidebar: [
        { label: 'Getting started', items: [{ autogenerate: { directory: 'getting-started' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
      ],
    }),
  ],
})

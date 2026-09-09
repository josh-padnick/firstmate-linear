# FM Linear documentation site

The site uses Astro and Starlight, with human-facing guides and a dedicated “For agents” section.
The site uses the selected Gallery direction: monochrome type, spacious sections, and softly rounded example panels.
The homepage leads with the integration headline and a real Linear screenshot on desktop.
At narrow widths it presents one readable example issue with a concrete task, approval status, assignee, and Firstmate review request.
The first two feature illustrations remain screenshot placeholders; the customization section uses illustrative YAML linked to the configuration guide.
Install calls to action lead to setup; they do not execute an installer.

Shared typography, spacing, border, and radius tokens live in `src/styles/custom.css`.
Homepage layout and responsive examples live in `src/styles/gallery.css`.
The design applies [proximity, alignment, repetition, and contrast](https://wiredcraft.com/blog/robin-williams-four-basic-design-principles-for-non-designers/): keep captions with their examples, align text and frames, repeat tokens, and use type hierarchy to distinguish the product promise from supporting detail.
Verify at 390px and desktop widths, with keyboard focus, light and dark contrast, and 200% browser zoom.
For comprehension, a reader of the mobile example should be able to identify the work (team invitations), its stage (plan approval), who acts next (you), and how to respond (review the plan and comment).
A fresh-reader usability session remains the way to confirm that understanding with people.

FM Linear uses a plain text site title; the homepage presents the separate Firstmate and Linear brands.

## Run locally

From the repository root:

```sh
bun install --frozen-lockfile
bun run docs:dev
```

The server prints its local URL.
To check and build the static site:

```sh
bun run docs:check
bun run docs:build
bun run docs:preview
```

The build output is `docs/dist/`.
Hosting is not configured, and these commands do not publish the site.
Set Astro's `site` option to the chosen production URL before deployment so Starlight can generate a sitemap.
Until then, the build reports that sitemap generation is skipped.

## Edit content

Write pages in `src/content/docs/` and configure navigation in `astro.config.mjs`.
The homepage integration figure lives in `src/components/IntegrationShowcase.astro`.
Replace the generic Linear screenshot URL and metadata in `src/data/visuals.ts` when an actual FM Linear workspace capture is available.
The figure links to the public Linear documentation source and loads its screenshot from Linear’s asset host.
The Firstmate portrait in `public/firstmate-logo.png` is the unchanged image supplied by the project owner.
The Firstmate and Linear marks sit above the hero headline, independently of the product screenshot.
The unmodified Linear wordmarks in `public/linear-wordmark-{dark,light}.svg` come from [Linear's official brand asset bundle](https://linear.app/brand).
Third-party brand imagery remains attributed to its owners; the combined relationship diagram describes an independent integration.
The random seed used during design is intentionally excluded from the repository and the page.
Keep unreleased behavior clearly identified and avoid publishing invented installation commands.
Keep implementation details in the repository's `_internal/` documents.

import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import accessibleAsideTitles from './src/plugins/accessible-aside-titles.mjs';

export default defineConfig({
  markdown: { processor: unified({ rehypePlugins: [accessibleAsideTitles] }) },
  integrations: [starlight({
    title: 'FM Linear',
    description: 'Follow your Firstmate crew, review their work, and keep the conversation in Linear.',
    favicon: '/favicon.svg',
    customCss: ['./src/styles/custom.css', './src/styles/gallery.css'],
    components: {
      Hero: './src/components/HomeHero.astro',
      SiteTitle: './src/components/SiteTitle.astro',
      SocialIcons: './src/components/NavLinks.astro',
      Footer: './src/components/Footer.astro',
    },
    sidebar: [
      { label: 'Start here', items: [
        { label: 'What is FM Linear?', slug: 'overview' },
        { label: 'Set up FM Linear', slug: 'guides/setup' },
        { label: 'Affiliation', slug: 'affiliation' },
      ] },
      { label: 'Workflow', items: [
        { label: 'Request new work', slug: 'guides/workflow' },
        { label: 'Give feedback', slug: 'guides/reviews' },
        { label: 'Approve a plan', slug: 'guides/approve-plan' },
        { label: 'Approve a deliverable', slug: 'guides/approve-deliverable' },
        { label: 'Merge a PR', slug: 'guides/merge-pr' },
        { label: 'Configuration', slug: 'reference/configuration' },
        { label: 'Track progress', slug: 'guides/track-work' },
      ] },
      { label: 'Reference', items: [
        { label: 'CLI commands', slug: 'reference/cli' },
        { label: 'Workflow configuration', slug: 'reference/workflow' },
        { label: 'Compatibility', slug: 'reference/compatibility' },
      ] },
      { label: 'How it works', items: [
        { label: 'Overview', slug: 'reference/architecture' },
        { label: 'Updating task briefs', slug: 'reference/firstmate' },
        { label: 'Sending messages', slug: 'reference/messages' },
        { label: 'Synchronizing issues', slug: 'reference/synchronization' },
        { label: 'Metrics', slug: 'reference/metrics' },
        { label: 'Reporting bugs', slug: 'guides/troubleshooting' },
      ] },
      { label: 'For agents', items: [
        { label: 'Overview', slug: 'for-agents' },
        { label: 'Reporting bugs', slug: 'for-agents/reporting-bugs' },
      ] },
    ],
    tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
    editLink: { baseUrl: 'https://github.com/josh-padnick/fm-linear/edit/main/docs/' },
  })],
});

import type { ResolvedShareLink } from './share-link'

// Decision logic for the /share/[token] route, extracted so we can
// unit-test it without an Astro SSR harness. The .astro file is a
// thin renderer that calls buildSharePageView() and branches on
// view.component.

export interface SharePageView {
  // Page title fed to <Layout title=...>. NOTE: Layout.astro
  // auto-appends " · Union" — these strings must NOT include it.
  title: string
  // og: / twitter: description fed to <ShareMeta>.
  description: string
  // Which leaf component the route should render.
  // 'voice' | 'prayer' | 'dead' — matches the three SharePage*.astro
  // files (Voice, Prayer, Dead).
  component: 'voice' | 'prayer' | 'dead'
  // CTA visibility. Dead state is opaque per spec §3: expired /
  // retracted / never-existed all render the same, with NO install
  // CTA — probers must not be able to distinguish from outside.
  showCTA: boolean
}

export function buildSharePageView(resolved: ResolvedShareLink): SharePageView {
  if (resolved.kind === 'alive' && resolved.prayer_kind === 'composed_voice') {
    return {
      title: 'A voice prayer',
      description: 'Someone shared a voice prayer with you on Union.',
      component: 'voice',
      showCTA: true,
    }
  }
  if (resolved.kind === 'alive') {
    return {
      title: resolved.title,
      description: 'Someone shared a prayer with you on Union.',
      component: 'prayer',
      showCTA: true,
    }
  }
  return {
    title: 'This prayer link is no longer active',
    description: 'This share link has expired or is no longer active.',
    component: 'dead',
    showCTA: false,
  }
}

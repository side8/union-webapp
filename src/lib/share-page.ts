import type { ResolvedShareLink } from './share-link'

// Decision logic for the /share/[token] route, extracted so we can
// unit-test it without an Astro SSR harness. The .astro file is a
// thin renderer that calls buildSharePageView() and branches on
// view.component.

// Minimal shape of the Workers Rate Limiting binding (GA form, see
// https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
// Kept local — we don't want to pull @cloudflare/workers-types into
// the surface area of this file just for one binding.
export interface RateLimitBinding {
  limit: (opts: { key: string }) => Promise<{ success: boolean }>
}

export interface ShareRouteEnv {
  SHARE_RATE_LIMIT?: RateLimitBinding
}

// Returns true if the request should be rate-limited (treated as
// dead). Defensive on the binding: in local `npm run dev` there's
// no Cloudflare runtime and the binding is undefined, in which case
// we let everything through.
export async function shouldRateLimit(
  env: ShareRouteEnv | undefined,
  ip: string,
): Promise<boolean> {
  if (!env?.SHARE_RATE_LIMIT) return false
  const { success } = await env.SHARE_RATE_LIMIT.limit({ key: `share:${ip}` })
  return !success
}

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

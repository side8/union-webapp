import { resolveShareLink, type ResolvedShareLink } from './share-link'

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

// Cloudflare Secrets Store binding runtime shape: an object with an
// async get() that resolves the secret string. NOT a plain string,
// and NOT on import.meta.env — it arrives per-request on
// Astro.locals.runtime.env.
export interface SecretsStoreSecret {
  get(): Promise<string>
}

export interface ShareRouteEnv {
  SHARE_RATE_LIMIT?: RateLimitBinding
  SUPABASE_URL?: SecretsStoreSecret
  SUPABASE_ANON_KEY?: SecretsStoreSecret
}

// Resolve Supabase credentials for the SSR share route.
// Production: read the Secrets Store bindings (async .get()).
// Local dev (`npm run dev`, no Cloudflare runtime / no bindings):
// fall back to Vite build-time env from a local .env so dev still
// works. Returns null when neither source yields both values — the
// route then renders the opaque dead state rather than throwing.
export async function resolveSupabaseCreds(
  env: ShareRouteEnv | undefined,
): Promise<{ url: string; anonKey: string } | null> {
  if (env?.SUPABASE_URL && env?.SUPABASE_ANON_KEY) {
    const [url, anonKey] = await Promise.all([
      env.SUPABASE_URL.get(),
      env.SUPABASE_ANON_KEY.get(),
    ])
    if (url && anonKey) return { url, anonKey }
  }
  // Local dev fallback: Vite build-time env from a local .env.
  const url = import.meta.env.SUPABASE_URL
  const anonKey = import.meta.env.SUPABASE_ANON_KEY
  if (url && anonKey) return { url, anonKey }
  return null
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

// The route needs both the rendering decision (SharePageView) AND
// the resolved link itself — the voice/prayer leaf components are fed
// the prayer fields (audio_url, body, from_label, expires_at) off the
// alive link. So the orchestrator surfaces both, spreading the view's
// fields and carrying `resolved` for the alive branches.
export type ShareViewResult = SharePageView & { resolved: ResolvedShareLink }

function toResult(resolved: ResolvedShareLink): ShareViewResult {
  return { ...buildSharePageView(resolved), resolved }
}

// Orchestrates the whole /share/[token] decision: rate-limit →
// creds → resolve → view. Wrapped so the public route NEVER throws
// a 500 — any failure renders the opaque dead state (spec §3).
export async function resolveShareView(
  env: ShareRouteEnv | undefined,
  token: string,
  ip: string,
): Promise<ShareViewResult> {
  try {
    if (await shouldRateLimit(env, ip)) return toResult({ kind: 'dead' })
    const creds = await resolveSupabaseCreds(env)
    if (!creds) return toResult({ kind: 'dead' })
    const resolved = await resolveShareLink(token, creds)
    return toResult(resolved)
  } catch {
    return toResult({ kind: 'dead' })
  }
}

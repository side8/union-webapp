import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  buildSharePageView,
  resolveSupabaseCreds,
  shouldRateLimit,
} from './share-page'
import type { ResolvedShareLink } from './share-link'

// Shared fixtures so the case-by-case asserts read clearly.
const aliveCorpus: ResolvedShareLink = {
  kind: 'alive',
  prayer_kind: 'corpus',
  title: 'A Collect for Aid',
  body: 'Lighten our darkness…',
  from_label: 'Sarah',
  audio_url: null,
  expires_at: '2099-01-01T00:00:00Z',
}

const aliveComposedText: ResolvedShareLink = {
  kind: 'alive',
  prayer_kind: 'composed_text',
  title: 'A prayer',
  body: 'O God of peace…',
  from_label: 'Sarah',
  audio_url: null,
  expires_at: '2099-01-01T00:00:00Z',
}

const aliveVoiceWithAudio: ResolvedShareLink = {
  kind: 'alive',
  prayer_kind: 'composed_voice',
  title: 'Voice prayer',
  body: '',
  from_label: null,
  audio_url: 'https://signed/x?ttl=300',
  expires_at: '2099-01-01T00:00:00Z',
}

const aliveVoiceNoAudio: ResolvedShareLink = {
  kind: 'alive',
  prayer_kind: 'composed_voice',
  title: 'Voice prayer',
  body: '',
  from_label: null,
  // Plan C decision 3: composed_voice with audio_url:null is STILL
  // alive. The component shows a fallback; the route must not
  // demote it to dead.
  audio_url: null,
  expires_at: '2099-01-01T00:00:00Z',
}

const dead: ResolvedShareLink = { kind: 'dead' }

describe('buildSharePageView', () => {
  test('alive corpus → prayer component, CTA shown, title uses prayer title', () => {
    const view = buildSharePageView(aliveCorpus)
    expect(view.component).toBe('prayer')
    expect(view.showCTA).toBe(true)
    expect(view.title).toBe('A Collect for Aid')
    expect(view.description).toContain('prayer')
  })

  test('alive composed_text → prayer component, CTA shown', () => {
    const view = buildSharePageView(aliveComposedText)
    expect(view.component).toBe('prayer')
    expect(view.showCTA).toBe(true)
    expect(view.title).toBe('A prayer')
  })

  test('alive composed_voice (with audio_url) → voice component, CTA shown', () => {
    const view = buildSharePageView(aliveVoiceWithAudio)
    expect(view.component).toBe('voice')
    expect(view.showCTA).toBe(true)
    expect(view.title).toBe('A voice prayer')
    expect(view.description).toContain('voice prayer')
  })

  test('alive composed_voice (audio_url null) → voice component, CTA shown (still alive, just degraded)', () => {
    const view = buildSharePageView(aliveVoiceNoAudio)
    expect(view.component).toBe('voice')
    expect(view.showCTA).toBe(true)
    expect(view.title).toBe('A voice prayer')
  })

  test('dead → dead component, no CTA, generic dead title (opaque per spec §3)', () => {
    const view = buildSharePageView(dead)
    expect(view.component).toBe('dead')
    expect(view.showCTA).toBe(false)
    expect(view.title).toBe('This prayer link is no longer active')
    // Description must not leak whether the link expired, was
    // retracted, or never existed.
    expect(view.description).toMatch(/expired or is no longer active/)
  })
})

describe('shouldRateLimit', () => {
  test('returns false when env is undefined (local `npm run dev`, no Cloudflare runtime)', async () => {
    expect(await shouldRateLimit(undefined, '1.2.3.4')).toBe(false)
  })

  test('returns false when SHARE_RATE_LIMIT binding is absent', async () => {
    expect(await shouldRateLimit({}, '1.2.3.4')).toBe(false)
  })

  test('returns false when binding allows the request (success:true)', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true })
    const env = { SHARE_RATE_LIMIT: { limit } }
    expect(await shouldRateLimit(env, '1.2.3.4')).toBe(false)
  })

  test('returns true when binding rejects the request (success:false)', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false })
    const env = { SHARE_RATE_LIMIT: { limit } }
    expect(await shouldRateLimit(env, '1.2.3.4')).toBe(true)
  })

  test('keys the limit call by `share:${ip}` so different IPs get independent buckets', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true })
    const env = { SHARE_RATE_LIMIT: { limit } }
    await shouldRateLimit(env, '1.2.3.4')
    expect(limit).toHaveBeenCalledWith({ key: 'share:1.2.3.4' })
  })
})

describe('resolveSupabaseCreds', () => {
  // We control the import.meta.env fallback explicitly via
  // vi.stubEnv so the bindings-vs-fallback branches are deterministic
  // regardless of what Vite injects in the test environment.
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const secret = (value: string) => ({ get: () => Promise.resolve(value) })

  test('both Secrets Store bindings present → awaits .get() and returns creds', async () => {
    // Force the fallback empty so we KNOW the result came from the
    // bindings, not import.meta.env.
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    const env = {
      SUPABASE_URL: secret('https://x.supabase.co'),
      SUPABASE_ANON_KEY: secret('anon-from-store'),
    }
    const out = await resolveSupabaseCreds(env)
    expect(out).toEqual({
      url: 'https://x.supabase.co',
      anonKey: 'anon-from-store',
    })
  })

  test('bindings absent + no import.meta.env fallback → returns null', async () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    expect(await resolveSupabaseCreds(undefined)).toBeNull()
    expect(await resolveSupabaseCreds({})).toBeNull()
  })

  test('one binding present, other missing → falls through to (empty) fallback → null', async () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    const env = { SUPABASE_URL: secret('https://x.supabase.co') }
    expect(await resolveSupabaseCreds(env)).toBeNull()
  })

  test('no bindings but import.meta.env set (local dev) → returns env creds', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://local.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'local-anon')
    const out = await resolveSupabaseCreds({})
    expect(out).toEqual({
      url: 'https://local.supabase.co',
      anonKey: 'local-anon',
    })
  })
})

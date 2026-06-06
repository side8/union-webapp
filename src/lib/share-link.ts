import { supabase } from './supabase'

export type SharePrayerKind = 'corpus' | 'composed_text' | 'composed_voice'

export type ResolvedShareLink =
  | {
      kind: 'alive'
      prayer_kind: SharePrayerKind
      title: string
      body: string
      from_label: string | null
      audio_url: string | null
      expires_at: string
    }
  | { kind: 'dead' }

// Token must match the base62 length-10 format the mint generates
// (see union-supabase/supabase/functions/mint-share-link/token.ts).
// Cheap defence against bulk-scan probes with malformed input —
// rejects without ever issuing a Supabase call.
const TOKEN_PATTERN = /^[A-Za-z0-9]{10}$/

export function isValidShareToken(token: string): boolean {
  return TOKEN_PATTERN.test(token)
}

// Server-side resolver used by the SSR /share/[token] route.
// Reads from shared_prayer_links via the anon RLS policy
// "Shared links: anyone read alive" — alive rows only. For voice
// shares, calls the public share-audio-url edge function to mint
// a short-TTL signed URL.
export async function resolveShareLink(
  token: string,
): Promise<ResolvedShareLink> {
  if (!isValidShareToken(token)) return { kind: 'dead' }

  const { data, error } = await supabase
    .from('shared_prayer_links')
    .select(`
      id, prayer_kind, sender_name_snapshot,
      payload_text, payload_audio_path,
      expires_at, retracted_at,
      prayer:prayers ( title, text )
    `)
    .eq('id', token)
    .maybeSingle()

  if (error || !data) return { kind: 'dead' }
  if (data.retracted_at) return { kind: 'dead' }
  if (new Date(data.expires_at) <= new Date()) return { kind: 'dead' }

  const prayer_kind = data.prayer_kind as SharePrayerKind
  let title: string
  let body: string

  if (prayer_kind === 'corpus') {
    // Supabase's generated types model embedded joins as arrays
    // even when the FK guarantees a single row; cast through
    // unknown to the shape we actually receive.
    const p = data.prayer as unknown as
      | { title: string; text: string }
      | null
    if (!p) return { kind: 'dead' }
    title = p.title
    body = p.text
  } else if (prayer_kind === 'composed_text') {
    title = 'A prayer'
    body = data.payload_text ?? ''
  } else {
    title = 'Voice prayer'
    body = ''
  }

  let audio_url: string | null = null
  if (prayer_kind === 'composed_voice' && data.payload_audio_path) {
    audio_url = await fetchSignedAudioUrl(token)
  }

  return {
    kind: 'alive',
    prayer_kind,
    title,
    body,
    from_label: data.sender_name_snapshot,
    audio_url,
    expires_at: data.expires_at,
  }
}

async function fetchSignedAudioUrl(token: string): Promise<string | null> {
  // Server-side-only call. The Cloudflare Worker (this code path
  // during SSR) calls the public share-audio-url edge function.
  // No PUBLIC_ env vars; browser never makes this call.
  const url = `${import.meta.env.SUPABASE_URL}/functions/v1/share-audio-url`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.SUPABASE_ANON_KEY as string,
      },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { audio_url?: string }
    return json.audio_url ?? null
  } catch {
    return null
  }
}

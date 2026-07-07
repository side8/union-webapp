import { createSupabaseClient } from './supabase'

export type SharePrayerKind = 'corpus' | 'composed_text' | 'composed_voice'

export interface SupabaseCreds {
  url: string
  anonKey: string
}

export type ResolvedShareLink =
  | {
      kind: 'alive'
      prayer_kind: SharePrayerKind
      title: string
      body: string
      from_label: string | null
      audio_url: string | null
      // How the sender framed the share (shared_prayer_links.intent,
      // migration 029): 'for_others' is a one-way share, 'with_me' is
      // an invitation to pray together. Drives the receive-page copy.
      // Null/missing rows (pre-029) coerce to 'for_others'.
      intent: 'for_others' | 'with_me'
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
  creds: SupabaseCreds,
): Promise<ResolvedShareLink> {
  // Token-format short-circuit FIRST — the cheap-probe defence. An
  // invalid token never builds a client or issues any network call.
  if (!isValidShareToken(token)) return { kind: 'dead' }

  const supabase = createSupabaseClient(creds.url, creds.anonKey)

  const { data, error } = await supabase
    .from('shared_prayer_links')
    .select(`
      id, prayer_kind, sender_name_snapshot,
      payload_text, intent,
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

  // A composed_voice link always has audio by construction (mint requires it),
  // so gate on the kind rather than reading payload_audio_path — that column is
  // no longer granted to anon (migration 038: its first path segment is the
  // sender's user id). The signed URL is minted by the share-audio-url edge
  // function from the token alone.
  let audio_url: string | null = null
  if (prayer_kind === 'composed_voice') {
    audio_url = await fetchSignedAudioUrl(token, creds)
  }

  // Coerce a null/missing intent (pre-029 rows / safety) to the
  // one-way 'for_others' framing.
  const intent: 'for_others' | 'with_me' =
    data.intent === 'with_me' ? 'with_me' : 'for_others'

  return {
    kind: 'alive',
    prayer_kind,
    title,
    body,
    from_label: data.sender_name_snapshot,
    audio_url,
    intent,
    expires_at: data.expires_at,
  }
}

async function fetchSignedAudioUrl(
  token: string,
  creds: SupabaseCreds,
): Promise<string | null> {
  // Server-side-only call. The Cloudflare Worker (this code path
  // during SSR) calls the public share-audio-url edge function.
  // Creds arrive per-request; browser never makes this call.
  const url = `${creds.url}/functions/v1/share-audio-url`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: creds.anonKey,
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

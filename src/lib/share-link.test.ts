import { beforeEach, describe, expect, test, vi } from 'vitest'

// Set env vars BEFORE importing share-link (keeps any import.meta.env
// reads deterministic across the suite).
vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key-stub')

// Mock the supabase module BEFORE importing share-link.
// resolveShareLink now builds the client via the createSupabaseClient
// factory, so we mock that to return a chainable stub client. The
// chain (.from().select().eq().maybeSingle()) is preserved; per-test
// data is fed via maybeSingle. vi.mock is hoisted above all
// imports/consts, so we hoist the mock fns alongside it via
// vi.hoisted to keep them in scope.
const { maybeSingle, eq, select, fromMock, createClientMock } = vi.hoisted(
  () => {
    const maybeSingle = vi.fn()
    const eq = vi.fn().mockReturnValue({ maybeSingle })
    const select = vi.fn().mockReturnValue({ eq })
    const fromMock = vi.fn().mockReturnValue({ select })
    const createClientMock = vi.fn().mockReturnValue({ from: fromMock })
    return { maybeSingle, eq, select, fromMock, createClientMock }
  },
)

vi.mock('./supabase', () => ({
  createSupabaseClient: createClientMock,
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { resolveShareLink, isValidShareToken } from './share-link'

const creds = { url: 'https://x.supabase.co', anonKey: 'anon' }

beforeEach(() => {
  maybeSingle.mockReset()
  eq.mockClear()
  select.mockClear()
  fromMock.mockClear()
  createClientMock.mockClear()
  fetchMock.mockReset()
})

describe('isValidShareToken', () => {
  test('accepts a 10-char base62 token', () => {
    expect(isValidShareToken('AbCdEf1234')).toBe(true)
  })
  test('rejects too short', () => {
    expect(isValidShareToken('AbCdEf12')).toBe(false)
  })
  test('rejects too long', () => {
    expect(isValidShareToken('AbCdEf12345')).toBe(false)
  })
  test('rejects non-base62 characters', () => {
    expect(isValidShareToken('AbCdEf12-3')).toBe(false)
    expect(isValidShareToken('AbCdEf 123')).toBe(false)
    expect(isValidShareToken('AbCdEf12./')).toBe(false)
  })
  test('rejects empty', () => {
    expect(isValidShareToken('')).toBe(false)
  })
})

describe('resolveShareLink', () => {
  const validToken = 'AbCdEf1234'

  test('returns kind=dead for invalid tokens without building a client or hitting supabase', async () => {
    const out = await resolveShareLink('not-valid', creds)
    expect(out).toEqual({ kind: 'dead' })
    // Cheap-probe defence: the token-format short-circuit runs before
    // any client construction or network call.
    expect(createClientMock).not.toHaveBeenCalled()
    expect(fromMock).not.toHaveBeenCalled()
  })

  test('returns kind=dead when the row is missing', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null })
    const out = await resolveShareLink(validToken, creds)
    expect(out).toEqual({ kind: 'dead' })
  })

  test('returns kind=dead when retracted_at is set', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: validToken,
        prayer_kind: 'corpus',
        retracted_at: '2026-06-06T00:00:00Z',
        expires_at: '2099-01-01T00:00:00Z',
      },
      error: null,
    })
    const out = await resolveShareLink(validToken, creds)
    expect(out).toEqual({ kind: 'dead' })
  })

  test('returns kind=dead when expires_at is in the past', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: validToken,
        prayer_kind: 'corpus',
        retracted_at: null,
        expires_at: '2020-01-01T00:00:00Z',
      },
      error: null,
    })
    const out = await resolveShareLink(validToken, creds)
    expect(out).toEqual({ kind: 'dead' })
  })

  test('corpus alive: joins prayers and returns title + body + from + expires + intent', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: validToken,
        prayer_kind: 'corpus',
        sender_name_snapshot: 'Sarah',
        payload_text: null,
        payload_audio_path: null,
        intent: 'for_others',
        expires_at: '2099-01-01T00:00:00Z',
        retracted_at: null,
        prayer: { title: 'A Collect for Aid', text: 'Lighten our darkness…' },
      },
      error: null,
    })
    const out = await resolveShareLink(validToken, creds)
    // Client is built per request from the passed creds.
    expect(createClientMock).toHaveBeenCalledWith(
      'https://x.supabase.co',
      'anon',
    )
    // The resolver pulls `intent` in its column list.
    expect(select).toHaveBeenCalledWith(expect.stringContaining('intent'))
    expect(out).toEqual({
      kind: 'alive',
      prayer_kind: 'corpus',
      title: 'A Collect for Aid',
      body: 'Lighten our darkness…',
      from_label: 'Sarah',
      audio_url: null,
      intent: 'for_others',
      expires_at: '2099-01-01T00:00:00Z',
    })
  })

  test('alive with intent=with_me → resolved intent=with_me', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: validToken,
        prayer_kind: 'corpus',
        sender_name_snapshot: 'Sarah',
        payload_text: null,
        payload_audio_path: null,
        intent: 'with_me',
        expires_at: '2099-01-01T00:00:00Z',
        retracted_at: null,
        prayer: { title: 'A Collect for Aid', text: 'Lighten our darkness…' },
      },
      error: null,
    })
    const out = await resolveShareLink(validToken, creds)
    if (out.kind !== 'alive') throw new Error('expected alive')
    expect(out.intent).toBe('with_me')
  })

  test('alive with null/absent intent → defaults to for_others (older rows / safety)', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: validToken,
        prayer_kind: 'corpus',
        sender_name_snapshot: 'Sarah',
        payload_text: null,
        payload_audio_path: null,
        // intent omitted entirely (older row)
        expires_at: '2099-01-01T00:00:00Z',
        retracted_at: null,
        prayer: { title: 'A Collect for Aid', text: 'Lighten our darkness…' },
      },
      error: null,
    })
    const out = await resolveShareLink(validToken, creds)
    if (out.kind !== 'alive') throw new Error('expected alive')
    expect(out.intent).toBe('for_others')
  })

  test('composed_text alive: uses payload_text as body', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: validToken,
        prayer_kind: 'composed_text',
        sender_name_snapshot: 'Sarah',
        payload_text: 'O God of peace…',
        payload_audio_path: null,
        expires_at: '2099-01-01T00:00:00Z',
        retracted_at: null,
        prayer: null,
      },
      error: null,
    })
    const out = await resolveShareLink(validToken, creds)
    if (out.kind !== 'alive') throw new Error('expected alive')
    expect(out.body).toBe('O God of peace…')
    expect(out.audio_url).toBeNull()
    expect(out.title).toBe('A prayer')
  })

  test('composed_voice alive: calls share-audio-url and sets audio_url', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: validToken,
        prayer_kind: 'composed_voice',
        sender_name_snapshot: null,
        payload_text: null,
        payload_audio_path: 'sender-1/voice-1.m4a',
        expires_at: '2099-01-01T00:00:00Z',
        retracted_at: null,
        prayer: null,
      },
      error: null,
    })
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ audio_url: 'https://signed/x?ttl=300' }),
    } as never)

    const out = await resolveShareLink(validToken, creds)
    if (out.kind !== 'alive') throw new Error('expected alive')
    expect(out.audio_url).toBe('https://signed/x?ttl=300')
    expect(out.from_label).toBeNull()
    expect(out.body).toBe('')
    expect(out.title).toBe('Voice prayer')
    // fetchSignedAudioUrl uses the passed creds, not import.meta.env:
    // the edge-function URL is derived from creds.url and the apikey
    // header from creds.anonKey.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.supabase.co/functions/v1/share-audio-url',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'anon' }),
      }),
    )
  })

  test('composed_voice with audio-url endpoint failure → returns alive but null audio_url', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: validToken,
        prayer_kind: 'composed_voice',
        sender_name_snapshot: null,
        payload_text: null,
        payload_audio_path: 'sender-1/voice-1.m4a',
        expires_at: '2099-01-01T00:00:00Z',
        retracted_at: null,
        prayer: null,
      },
      error: null,
    })
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'sign failed' }),
    } as never)

    const out = await resolveShareLink(validToken, creds)
    if (out.kind !== 'alive') throw new Error('expected alive')
    expect(out.audio_url).toBeNull()
  })

  test('corpus alive with missing prayer join → returns dead', async () => {
    // If the join to prayers fails (foreign row deleted), the page
    // can't render — treat as dead.
    maybeSingle.mockResolvedValue({
      data: {
        id: validToken,
        prayer_kind: 'corpus',
        sender_name_snapshot: 'Sarah',
        payload_text: null,
        payload_audio_path: null,
        expires_at: '2099-01-01T00:00:00Z',
        retracted_at: null,
        prayer: null,
      },
      error: null,
    })
    const out = await resolveShareLink(validToken, creds)
    expect(out).toEqual({ kind: 'dead' })
  })
})

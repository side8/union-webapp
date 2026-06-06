import { beforeEach, describe, expect, test, vi } from 'vitest'

// Set env vars BEFORE importing share-link (or supabase will throw).
vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key-stub')

// Mock the supabase module BEFORE importing share-link.
// vi.mock is hoisted above all imports/consts, so we hoist the
// mock fns alongside it via vi.hoisted to keep them in scope.
const { maybeSingle, eq, select, fromMock } = vi.hoisted(() => {
  const maybeSingle = vi.fn()
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const fromMock = vi.fn().mockReturnValue({ select })
  return { maybeSingle, eq, select, fromMock }
})

vi.mock('./supabase', () => ({
  supabase: { from: fromMock },
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { resolveShareLink, isValidShareToken } from './share-link'

beforeEach(() => {
  maybeSingle.mockReset()
  eq.mockClear()
  select.mockClear()
  fromMock.mockClear()
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

  test('returns kind=dead for invalid tokens without hitting supabase', async () => {
    const out = await resolveShareLink('not-valid')
    expect(out).toEqual({ kind: 'dead' })
    expect(fromMock).not.toHaveBeenCalled()
  })

  test('returns kind=dead when the row is missing', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null })
    const out = await resolveShareLink(validToken)
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
    const out = await resolveShareLink(validToken)
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
    const out = await resolveShareLink(validToken)
    expect(out).toEqual({ kind: 'dead' })
  })

  test('corpus alive: joins prayers and returns title + body + from + expires', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: validToken,
        prayer_kind: 'corpus',
        sender_name_snapshot: 'Sarah',
        payload_text: null,
        payload_audio_path: null,
        expires_at: '2099-01-01T00:00:00Z',
        retracted_at: null,
        prayer: { title: 'A Collect for Aid', text: 'Lighten our darkness…' },
      },
      error: null,
    })
    const out = await resolveShareLink(validToken)
    expect(out).toEqual({
      kind: 'alive',
      prayer_kind: 'corpus',
      title: 'A Collect for Aid',
      body: 'Lighten our darkness…',
      from_label: 'Sarah',
      audio_url: null,
      expires_at: '2099-01-01T00:00:00Z',
    })
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
    const out = await resolveShareLink(validToken)
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

    const out = await resolveShareLink(validToken)
    if (out.kind !== 'alive') throw new Error('expected alive')
    expect(out.audio_url).toBe('https://signed/x?ttl=300')
    expect(out.from_label).toBeNull()
    expect(out.body).toBe('')
    expect(out.title).toBe('Voice prayer')
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

    const out = await resolveShareLink(validToken)
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
    const out = await resolveShareLink(validToken)
    expect(out).toEqual({ kind: 'dead' })
  })
})

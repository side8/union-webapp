import { describe, expect, test } from 'vitest'
import { buildSharePageView } from './share-page'
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

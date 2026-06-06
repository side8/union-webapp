# Shared Prayer Receive — Web Implementation Plan (Plan C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the public `https://unionwith.app/share/<token>` page (the fallback for recipients tapping a share link without Union installed) plus the AASA + assetlinks files iOS and Android need to verify the universal-link claim, plus a small Supabase precursor that mints short-TTL audio signed URLs for voice shares.

**Architecture:** union-webapp switches from 100% static Astro to **hybrid SSR via the `@astrojs/cloudflare` adapter** — just the `/share/[token]` route is server-rendered on the Cloudflare Worker; every other page (home, privacy, terms, support) keeps `prerender = true` and stays statically built. The share route resolves the token by `select`ing from `public.shared_prayer_links` with the anon key (the migration-026 RLS policy `"Shared links: anyone read alive"` already grants this for alive rows). For voice shares, the route calls a new public `share-audio-url` edge function on `union-supabase` to mint a 5-minute signed URL. AASA + assetlinks files ship as static `public/.well-known/*` assets.

**Tech stack:** Astro 6.3 · TailwindCSS v4 · TypeScript · `@astrojs/cloudflare` adapter · `@supabase/supabase-js` (browser-bundle-safe) · Cloudflare Workers (Static Assets + the new Worker entry for SSR) · Vitest for unit tests on the resolver helper.

**Source spec:** [`shared-prayer-receive.md`](https://github.com/side8/union-notes/blob/main/content/product/shared-prayer-receive.md) in `union-notes`. Plan A (backend) at [union-supabase PR #47](https://github.com/side8/union-supabase/pull/47) (merged). Plan B (app) at [union-app PR #147](https://github.com/side8/union-app/pull/147) (merged). Migration 028 (`journal_from_labels`) at [union-supabase PR #48](https://github.com/side8/union-supabase/pull/48) (merged).

---

## Three decisions made in this plan (flag if any are wrong)

1. **Web "Save to Union" CTA deferred.** The spec describes two CTAs on the public page — *"Save to Union"* (which requires web-side Supabase auth) and *"Get Union"* (App Store / Play Store). Plan C ships **only "Get Union"**. Web auth on a currently-100%-static marketing site is a major surface-area expansion (login UI, session cookies, the inline-auth-then-return-to-save flow); deferring it lets Plan C ship the rest of the spec's web surface without that complexity. Recipients who install Union and tap the link again get the full save flow via the universal link delivered in Plan B.

   *Implication:* the public page is read-only for the prayer content. No journal entry gets created from the web. The "Save to Union" CTA in the spec becomes a follow-up — call it Plan E or fold into a later web-auth pass.

2. **Voice playback on web requires a public audio endpoint.** Spec §6: *"Audio uses a signed URL that only the share page can resolve."* Plan A's `redeem-share-link` mints signed URLs but requires auth (and creates a journal entry). Plan C adds a small precursor edge function `share-audio-url` on `union-supabase` with `verify_jwt = false` — anon callers pass the token, the function verifies the link is alive and the kind is `composed_voice`, then returns a 5-minute signed URL. Modelled on the existing public `bible` and `daily-verse` functions.

3. **Hybrid SSR via the `@astrojs/cloudflare` adapter.** Today union-webapp is 100% static. Adding the adapter lets the `/share/[token]` page be server-rendered on the Cloudflare Worker (good for rich-preview metadata + reverent first paint without a loading spinner) while everything else stays static-prerendered. The wrangler.jsonc comment anticipates this: *"If we ever need server-side handling... add a `main` entry pointing at a Worker script."*

> If decision 1 is wrong (and you want Save-to-Union shipped on web in this batch), Plan C grows by ~6 tasks (Supabase auth init, sign-in UI, post-auth resume-state, redeem call from the browser, the test surface). Worth confirming before execution.

> If decision 2 is wrong, the only alternative is *"voice shares only play in the app"* — the web page would show a *"Install Union to play this voice prayer"* card instead of a playback control. Smaller scope, but breaks the spec's "audio plays on the web" promise.

> If decision 3 is wrong, the alternative is *"keep the site fully static; render `/share/[token]` as a thin HTML shell that fetches the prayer client-side."* That works but loses rich-preview metadata for WhatsApp/iMessage link unfurling (the page meta is identical for every token) and shows a loading state on first paint. The reverent tone of Union argues against the loading state.

---

## File structure

This plan creates / modifies the following files.

**New files**

| Path | Responsibility |
|---|---|
| `../union-supabase/supabase/functions/share-audio-url/index.ts` | Public edge function: token → signed audio URL. Verifies link is alive + kind is composed_voice. |
| `../union-supabase/supabase/functions/share-audio-url/orchestrator.ts` | Pure orchestration. |
| `../union-supabase/supabase/functions/share-audio-url/auth.ts` | Anon Supabase client construction (no `getUser`). |
| `../union-supabase/supabase/functions/share-audio-url/service.ts` | `fetchAliveLink` + `signAudioUrl` factories. |
| `../union-supabase/supabase/functions/tests/share-audio-url-orchestrator-test.ts` | Unit tests for the orchestrator. |
| `src/pages/share/[token].astro` | SSR share-page route. |
| `src/lib/supabase.ts` | Browser-safe supabase client + env-var loader (small wrapper). |
| `src/lib/share-link.ts` | `resolveShareLink(token)` server-side helper; returns the shape the page renders. |
| `src/lib/share-link.test.ts` | Vitest tests for the resolver. |
| `src/components/SharePagePrayer.astro` | Renders the prayer body + From line for text shares. |
| `src/components/SharePageVoice.astro` | Renders the audio playback control for voice shares. |
| `src/components/SharePageDead.astro` | Dead-state copy: *"This prayer link is no longer active."* |
| `src/components/InstallCTAs.astro` | App Store / Play Store / *Why Union* card. |
| `src/components/ShareMeta.astro` | Open Graph + Twitter Card meta tags slot, parameterised. |
| `public/.well-known/apple-app-site-association` | iOS universal-link verification. |
| `public/.well-known/assetlinks.json` | Android App Links verification. |

**Modified files**

| Path | Change |
|---|---|
| `package.json` | Add `@astrojs/cloudflare`, `@supabase/supabase-js`, `vitest`, `@vitest/coverage-v8`. New `test` and `typecheck` scripts. |
| `astro.config.mjs` | `import cloudflare from '@astrojs/cloudflare'` + `output: 'hybrid'` + `adapter: cloudflare()`. |
| `src/layouts/Layout.astro` | Accept an optional `<slot name="head" />` so the share page can inject OG meta. |
| `wrangler.jsonc` | Reference the adapter's `_worker.js` output (the adapter writes it on build). Add a comment explaining the static + worker hybrid. |
| `tsconfig.json` | Confirm strict mode + add `vitest/globals` types. |
| `.env.example` (new) | `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` (the prefix Astro uses for client-side vars). |

---

## Task 1: Supabase precursor — `share-audio-url` edge function

A small, public, no-auth edge function that takes a token and returns a 5-minute signed URL for the voice payload — if and only if the link is alive AND the kind is `composed_voice`. Modelled on the public `bible` / `daily-verse` functions in `union-supabase`.

**Repo for this task only:** `/Users/duncancrawford/development/workspace/side8/holy-products/union-supabase` on a fresh branch `feat/share-audio-url`. Open as a separate PR.

**Files (new):**
- `supabase/functions/share-audio-url/orchestrator.ts`
- `supabase/functions/share-audio-url/auth.ts`
- `supabase/functions/share-audio-url/service.ts`
- `supabase/functions/share-audio-url/index.ts`
- `supabase/functions/tests/share-audio-url-orchestrator-test.ts`

**Files (modified):**
- `supabase/config.toml` — append `[functions.share-audio-url]` with `verify_jwt = false`.

- [ ] **Step 1: Write the failing orchestrator test**

Create `supabase/functions/tests/share-audio-url-orchestrator-test.ts`:

```typescript
import { assert, assertEquals } from '@std/assert'
import {
  type ShareAudioUrlDeps,
  runShareAudioUrl,
} from '../share-audio-url/orchestrator.ts'
import { noopLogger } from '../_shared/log.ts'

const voiceLink = {
  id: 'tok-1',
  prayer_kind: 'composed_voice' as const,
  payload_audio_path: 'sender-1/voice-1.m4a',
  expires_at: new Date('2099-01-01').toISOString(),
  retracted_at: null,
}

function makeDeps(overrides: Partial<ShareAudioUrlDeps> = {}): ShareAudioUrlDeps {
  return {
    fetchAliveLink: () => Promise.resolve(voiceLink),
    signAudioUrl: () => Promise.resolve('https://signed/x?ttl=300'),
    log: noopLogger,
    ...overrides,
  }
}

Deno.test('missing token → 400', async () => {
  const out = await runShareAudioUrl('', makeDeps())
  assertEquals(out, { kind: 'error', status: 400, error: 'Missing token' })
})

Deno.test('dead link → 404', async () => {
  const out = await runShareAudioUrl('tok-1', makeDeps({
    fetchAliveLink: () => Promise.resolve(null),
  }))
  assertEquals(out, { kind: 'error', status: 404, error: 'Not found' })
})

Deno.test('alive link but wrong kind (composed_text) → 404 (no audio to sign)', async () => {
  const out = await runShareAudioUrl('tok-1', makeDeps({
    fetchAliveLink: () => Promise.resolve({
      ...voiceLink,
      prayer_kind: 'composed_text',
      payload_audio_path: null,
    } as never),
  }))
  assertEquals(out, { kind: 'error', status: 404, error: 'Not found' })
})

Deno.test('voice share returns the signed URL', async () => {
  const out = await runShareAudioUrl('tok-1', makeDeps())
  assertEquals(out, { kind: 'ok', audio_url: 'https://signed/x?ttl=300' })
})

Deno.test('voice share with null payload_audio_path → 500 (data inconsistent)', async () => {
  const out = await runShareAudioUrl('tok-1', makeDeps({
    fetchAliveLink: () => Promise.resolve({
      ...voiceLink,
      payload_audio_path: null,
    }),
  }))
  assertEquals(out.kind, 'error')
  if (out.kind === 'error') assertEquals(out.status, 500)
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd supabase/functions && deno test tests/share-audio-url-orchestrator-test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the orchestrator**

Create `supabase/functions/share-audio-url/orchestrator.ts`:

```typescript
import type { Logger } from '../_shared/log.ts'
import { errMsg } from '../_shared/util/errors.ts'

export interface AliveLink {
  id: string
  prayer_kind: 'corpus' | 'composed_text' | 'composed_voice'
  payload_audio_path: string | null
  expires_at: string
  retracted_at: string | null
}

export interface ShareAudioUrlDeps {
  fetchAliveLink: (token: string) => Promise<AliveLink | null>
  signAudioUrl: (path: string) => Promise<string>
  log: Logger
}

export type ShareAudioUrlOutcome =
  | { kind: 'ok'; audio_url: string }
  | { kind: 'error'; status: number; error: string }

export async function runShareAudioUrl(
  token: string,
  deps: ShareAudioUrlDeps,
): Promise<ShareAudioUrlOutcome> {
  if (!token) return { kind: 'error', status: 400, error: 'Missing token' }

  const link = await deps.fetchAliveLink(token)
  if (!link) return { kind: 'error', status: 404, error: 'Not found' }
  if (link.prayer_kind !== 'composed_voice') {
    // Opaque 404 — don't disclose existence-and-wrong-kind.
    return { kind: 'error', status: 404, error: 'Not found' }
  }
  if (!link.payload_audio_path) {
    deps.log.error('audio_path_missing', { token })
    return { kind: 'error', status: 500, error: 'Audio path missing' }
  }

  try {
    const audio_url = await deps.signAudioUrl(link.payload_audio_path)
    deps.log.info('audio_signed', { token })
    return { kind: 'ok', audio_url }
  } catch (err) {
    deps.log.error('sign_failed', { token, err: errMsg(err) })
    return { kind: 'error', status: 500, error: 'Failed to sign audio URL' }
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd supabase/functions && deno test tests/share-audio-url-orchestrator-test.ts
```

Expected: PASS — 5 cases.

- [ ] **Step 5: Implement `auth.ts`, `service.ts`, `index.ts`**

`auth.ts` — anon client (no getUser since this is public):

```typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export function createAnonClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!url || !anonKey) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set')
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
}
```

`service.ts`:

```typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AliveLink } from './orchestrator.ts'

const VOICE_BUCKET = 'voice-prayers'
const AUDIO_URL_TTL_SECONDS = 300

export function createServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceRoleKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export function createFetchAliveLink(client: SupabaseClient) {
  return async (token: string): Promise<AliveLink | null> => {
    const { data, error } = await client
      .from('shared_prayer_links')
      .select('id, prayer_kind, payload_audio_path, expires_at, retracted_at')
      .eq('id', token)
      .maybeSingle()
    if (error) throw new Error(`fetchAliveLink: ${error.message}`)
    if (!data) return null
    if (data.retracted_at) return null
    if (new Date(data.expires_at) <= new Date()) return null
    return data as AliveLink
  }
}

export function createSignAudioUrl(client: SupabaseClient) {
  return async (storagePath: string): Promise<string> => {
    const { data, error } = await client.storage
      .from(VOICE_BUCKET)
      .createSignedUrl(storagePath, AUDIO_URL_TTL_SECONDS)
    if (error) throw new Error(`signAudioUrl: ${error.message}`)
    return data.signedUrl
  }
}
```

> **Note:** `fetchAliveLink` uses the **anon** client (caller can be anonymous — the RLS policy `"Shared links: anyone read alive"` grants anon SELECT on alive rows). `signAudioUrl` uses the **service-role** client because `storage.from(...).createSignedUrl` requires it. Separation of concerns matches the pattern in `redeem-share-link/service.ts`.

`index.ts`:

```typescript
import { createAnonClient } from './auth.ts'
import {
  createServiceClient,
  createFetchAliveLink,
  createSignAudioUrl,
} from './service.ts'
import { runShareAudioUrl } from './orchestrator.ts'
import { createConsoleLogger } from '../_shared/log.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: { token?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  if (!body.token) return json({ error: 'Missing token' }, 400)

  const anonClient = createAnonClient()
  const serviceClient = createServiceClient()

  const outcome = await runShareAudioUrl(body.token, {
    fetchAliveLink: createFetchAliveLink(anonClient),
    signAudioUrl: createSignAudioUrl(serviceClient),
    log: createConsoleLogger('share-audio-url'),
  })

  if (outcome.kind === 'error') return json({ error: outcome.error }, outcome.status)
  return json({ audio_url: outcome.audio_url })
})
```

- [ ] **Step 6: Register in `config.toml`**

Append:

```toml
[functions.share-audio-url]
# Public audio signed-URL minter for voice prayer shares on
# unionwith.app/share/<token>. Verifies the link is alive
# (expires_at > now() AND retracted_at IS NULL) AND kind is
# composed_voice, then returns a 5-minute signed URL for the
# audio bytes. Same opaque-404 contract as redeem-share-link:
# missing / wrong-kind / dead all return 404 with no
# disclosure.
verify_jwt = false
```

- [ ] **Step 7: Run `deno check` + full test suite**

```bash
cd supabase/functions && deno check **/*.ts && deno test tests/
```

All previously-passing tests still pass; the new file's 5 tests pass.

- [ ] **Step 8: Commit + push + open PR**

```bash
git checkout -b feat/share-audio-url
git add supabase/functions/share-audio-url/ supabase/functions/tests/share-audio-url-orchestrator-test.ts supabase/config.toml
git commit -m "feat(functions): share-audio-url — public audio signed-URL minter

Precursor for union-webapp Plan C. Verifies the share link is
alive AND kind is composed_voice, then mints a 5-minute signed
URL for the audio bytes. Opaque 404 for missing / wrong-kind /
dead — same contract as redeem-share-link.

Uses anon client for the alive-link lookup (RLS policy
'Shared links: anyone read alive' grants anon SELECT on alive
rows per migration 026) and the service-role client for the
storage signed URL (createSignedUrl requires service privileges).
"
git push -u origin feat/share-audio-url
gh pr create --title "feat(functions): share-audio-url — public audio signed-URL minter" --body "Precursor for union-webapp Plan C. See plan at union-webapp docs/superpowers/plans/2026-06-06-shared-prayer-receive-web.md Task 1."
```

- [ ] **Step 9: Wait for Supabase Preview + smoke tests to go green, merge**

The next tasks (Plan C proper, on union-webapp) consume this endpoint.

---

## Task 2: Install Cloudflare adapter + Vitest in union-webapp

Switch Astro from 100% static to hybrid SSR. Add the toolchain.

**Repo from here on:** `/Users/duncancrawford/development/workspace/side8/holy-products/union-webapp` on branch `feat/shared-prayer-receive-web`.

**Files modified:**
- `package.json`
- `astro.config.mjs`
- `tsconfig.json`
- `wrangler.jsonc`

**Files created:**
- `.env.example`
- `vitest.config.ts`

- [ ] **Step 1: Create the feature branch**

```bash
cd /Users/duncancrawford/development/workspace/side8/holy-products/union-webapp
git checkout main && git pull --ff-only
git checkout -b feat/shared-prayer-receive-web
```

- [ ] **Step 2: Add dependencies**

```bash
npm install --save @astrojs/cloudflare @supabase/supabase-js
npm install --save-dev vitest @vitest/coverage-v8
```

- [ ] **Step 3: Update `astro.config.mjs`**

Replace contents with:

```javascript
// @ts-check
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import tailwindcss from '@tailwindcss/vite'

// Hybrid: every page that doesn't opt out stays static-prerendered.
// The share page (src/pages/share/[token].astro) sets prerender=false
// and is rendered on each request by the Cloudflare Worker. Marketing
// pages (home / privacy / terms / support) keep their static perf.
export default defineConfig({
  output: 'static',
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  vite: {
    plugins: [tailwindcss()],
  },
})
```

> **Note:** with `output: 'static'`, Astro defaults every page to prerender. The share page will explicitly set `export const prerender = false` so only that one route hits the Worker at runtime.

- [ ] **Step 4: Update `wrangler.jsonc`**

The adapter writes a Worker entry to `./dist/_worker.js/index.js`. Replace contents:

```jsonc
{
  // Cloudflare Workers config — hybrid SSR after the @astrojs/cloudflare
  // adapter landed for /share/[token] (Plan C). Marketing pages stay
  // static; the share route runs in the Worker at request time.
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "union-webapp",
  "main": "./dist/_worker.js/index.js",
  "compatibility_date": "2026-05-18",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS"
  }
}
```

`nodejs_compat` is required by `@supabase/supabase-js`.

- [ ] **Step 5: Create `.env.example`**

```
# Public Supabase env vars for the SSR share-page resolver.
# Astro exposes any var prefixed with PUBLIC_ to both server and client.
PUBLIC_SUPABASE_URL=https://your-project.supabase.co
PUBLIC_SUPABASE_ANON_KEY=eyJxxx...
```

- [ ] **Step 6: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 7: Update `package.json` scripts**

Replace the `scripts` block:

```json
"scripts": {
  "dev": "astro dev",
  "build": "astro build",
  "preview": "astro preview",
  "astro": "astro",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "astro check"
}
```

- [ ] **Step 8: Run `astro check` to verify the adapter picks up cleanly**

```bash
npm run typecheck
```

Expected: clean (no errors). May report 0 issues across the existing static pages.

- [ ] **Step 9: Build and confirm `_worker.js` is generated**

```bash
npm run build
ls -la dist/_worker.js/
```

Expected: `index.js` exists.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json astro.config.mjs wrangler.jsonc tsconfig.json .env.example vitest.config.ts
git commit -m "chore(astro): hybrid SSR via @astrojs/cloudflare + vitest

Adds @astrojs/cloudflare adapter so individual pages can opt into
server-side rendering on the Cloudflare Worker. Every existing page
keeps the static perf (defaulted prerender=true).

Adds vitest for the share-link resolver unit tests landing in
subsequent tasks. nodejs_compat is on because @supabase/supabase-js
imports node:* modules.

.env.example documents the two Supabase env vars the share route
needs at SSR time (PUBLIC_ prefix so they're available to both
server-rendered and client-hydrated code paths).
"
```

---

## Task 3: Browser-safe supabase client + share-link resolver helper

Server-side helper that takes a token and returns a render-ready shape.

**Files:**
- Create: `src/lib/supabase.ts`
- Create: `src/lib/share-link.ts`
- Create: `src/lib/share-link.test.ts`

- [ ] **Step 1: Create `src/lib/supabase.ts`**

```typescript
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY not set — copy .env.example to .env.',
  )
}

// Anon-only client. The share page is public; no auth, no session.
// RLS on shared_prayer_links ("Shared links: anyone read alive")
// limits anon to alive rows.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
})
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/share-link.test.ts`:

```typescript
import { describe, expect, test, vi, beforeEach } from 'vitest'

// Mock the supabase module BEFORE importing share-link.
const maybeSingle = vi.fn()
const eq = vi.fn().mockReturnValue({ maybeSingle })
const select = vi.fn().mockReturnValue({ eq })
const fromMock = vi.fn().mockReturnValue({ select })

vi.mock('./supabase', () => ({
  supabase: { from: fromMock },
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { resolveShareLink } from './share-link'

beforeEach(() => {
  maybeSingle.mockReset()
  eq.mockClear()
  select.mockClear()
  fromMock.mockClear()
  fetchMock.mockReset()
})

describe('resolveShareLink', () => {
  test('returns kind=dead when the row is missing', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null })
    const out = await resolveShareLink('tok-1')
    expect(out).toEqual({ kind: 'dead' })
  })

  test('returns kind=dead when retracted_at is set', async () => {
    maybeSingle.mockResolvedValue({
      data: { id: 'tok-1', prayer_kind: 'corpus', retracted_at: '2026-06-06T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' },
      error: null,
    })
    const out = await resolveShareLink('tok-1')
    expect(out).toEqual({ kind: 'dead' })
  })

  test('returns kind=dead when expires_at is in the past', async () => {
    maybeSingle.mockResolvedValue({
      data: { id: 'tok-1', prayer_kind: 'corpus', retracted_at: null, expires_at: '2020-01-01T00:00:00Z' },
      error: null,
    })
    const out = await resolveShareLink('tok-1')
    expect(out).toEqual({ kind: 'dead' })
  })

  test('corpus alive: joins prayers and returns title + body + from + expires', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: 'tok-1',
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
    const out = await resolveShareLink('tok-1')
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
        id: 'tok-1',
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
    const out = await resolveShareLink('tok-1')
    if (out.kind !== 'alive') throw new Error('expected alive')
    expect(out.body).toBe('O God of peace…')
    expect(out.audio_url).toBeNull()
  })

  test('composed_voice alive: calls share-audio-url and sets audio_url', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: 'tok-1',
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

    const out = await resolveShareLink('tok-1')
    if (out.kind !== 'alive') throw new Error('expected alive')
    expect(out.audio_url).toBe('https://signed/x?ttl=300')
    expect(out.from_label).toBeNull()
    expect(out.body).toBe('') // voice has no text body
  })

  test('composed_voice with audio-url endpoint failure → returns alive but null audio_url', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: 'tok-1',
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

    const out = await resolveShareLink('tok-1')
    if (out.kind !== 'alive') throw new Error('expected alive')
    expect(out.audio_url).toBeNull()
  })
})
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
npm test -- src/lib/share-link.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/lib/share-link.ts`**

```typescript
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

// Server-side resolver used by the SSR /share/[token] route.
// Reads from shared_prayer_links via the anon RLS policy
// "Shared links: anyone read alive" — alive rows only. For voice
// shares, calls the public share-audio-url edge function to mint
// a short-TTL signed URL.
export async function resolveShareLink(token: string): Promise<ResolvedShareLink> {
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
    const p = data.prayer as { title: string; text: string } | null
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
  const url = `${import.meta.env.PUBLIC_SUPABASE_URL}/functions/v1/share-audio-url`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.PUBLIC_SUPABASE_ANON_KEY,
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
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
npm test -- src/lib/share-link.test.ts
```

Expected: PASS — all 7 cases.

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/supabase.ts src/lib/share-link.ts src/lib/share-link.test.ts
git commit -m "feat(lib): share-link resolver + supabase anon client

Server-side helper that resolves a share token to a render-ready
shape. Uses the anon RLS policy 'Shared links: anyone read alive'
to read shared_prayer_links + joined prayers row. For voice
shares, calls share-audio-url to mint a 5-minute signed URL.

Dead is the union catchall: missing / retracted / expired /
corpus row absent all map to { kind: 'dead' } so the page can
render a single soft state regardless of why.
"
```

---

## Task 4: Share-page route — `src/pages/share/[token].astro`

The SSR route. Calls `resolveShareLink`, then renders one of three component slots: text-prayer body, voice-prayer playback, dead state. Always renders OG meta + install CTAs in the layout slot.

**Files:**
- Create: `src/pages/share/[token].astro`

- [ ] **Step 1: Create the page**

```astro
---
import Layout from '../../layouts/Layout.astro'
import Header from '../../components/Header.astro'
import Footer from '../../components/Footer.astro'
import SharePagePrayer from '../../components/SharePagePrayer.astro'
import SharePageVoice from '../../components/SharePageVoice.astro'
import SharePageDead from '../../components/SharePageDead.astro'
import InstallCTAs from '../../components/InstallCTAs.astro'
import ShareMeta from '../../components/ShareMeta.astro'
import { resolveShareLink } from '../../lib/share-link'

// Hybrid mode opt-out from prerender — this route runs in the Worker
// at request time so each token resolves to the right prayer.
export const prerender = false

const { token } = Astro.params
const resolved = token ? await resolveShareLink(token) : { kind: 'dead' as const }

const pageTitle =
  resolved.kind === 'alive' ? `${resolved.title} · Union` : 'A prayer · Union'
const pageDescription =
  resolved.kind === 'alive'
    ? resolved.body.slice(0, 160) || 'A prayer shared on Union.'
    : 'This prayer link is no longer active.'
---

<Layout title={pageTitle} description={pageDescription}>
  <Fragment slot="head">
    <ShareMeta title={pageTitle} description={pageDescription} />
  </Fragment>

  <Header />

  <main class="share-page">
    {resolved.kind === 'dead' && <SharePageDead />}
    {resolved.kind === 'alive' && resolved.prayer_kind !== 'composed_voice' && (
      <SharePagePrayer
        title={resolved.title}
        body={resolved.body}
        fromLabel={resolved.from_label}
        expiresAt={resolved.expires_at}
      />
    )}
    {resolved.kind === 'alive' && resolved.prayer_kind === 'composed_voice' && (
      <SharePageVoice
        audioUrl={resolved.audio_url}
        fromLabel={resolved.from_label}
        expiresAt={resolved.expires_at}
      />
    )}

    <InstallCTAs />
  </main>

  <Footer />
</Layout>

<style>
  .share-page {
    max-width: 720px;
    margin: 0 auto;
    padding: 64px 24px;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/share/\[token\].astro
git commit -m "feat(web): SSR /share/[token] route

Hybrid-mode page (prerender=false) that resolves the token via
lib/share-link, then renders one of three component slots: text
prayer body, voice playback, or dead state. OG meta + install
CTAs are part of every render."
```

---

## Task 5: SharePagePrayer component (text shares)

Renders the prayer for `corpus` and `composed_text` kinds.

**Files:**
- Create: `src/components/SharePagePrayer.astro`

- [ ] **Step 1: Create the component**

```astro
---
interface Props {
  title: string
  body: string
  fromLabel: string | null
  expiresAt: string
}

const { title, body, fromLabel, expiresAt } = Astro.props

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  })
}

function daysUntil(iso: string): number {
  return Math.max(
    0,
    Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000),
  )
}

const days = daysUntil(expiresAt)
---

<article class="prayer-card">
  <h1>{title}</h1>
  <p class="body">{body}</p>
  {fromLabel && <p class="from"><em>From {fromLabel}</em></p>}
  <p class="expiry">Expires in {days} day{days === 1 ? '' : 's'} ({formatExpiry(expiresAt)}).</p>
</article>

<style>
  .prayer-card {
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    border-radius: 12px;
    padding: 48px 40px;
    margin-bottom: 48px;
  }
  .prayer-card h1 {
    font-family: var(--display-font);
    font-size: 36px;
    line-height: 1.1;
    margin: 0 0 24px 0;
    color: var(--ink);
  }
  .body {
    font-family: var(--body-font);
    font-size: 20px;
    line-height: 1.55;
    color: var(--ink);
    white-space: pre-wrap;
  }
  .from {
    margin-top: 24px;
    color: var(--ink-soft);
    font-size: 16px;
  }
  .expiry {
    margin-top: 32px;
    color: var(--ink-mute);
    font-family: var(--ui-font);
    font-size: 14px;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SharePagePrayer.astro
git commit -m "feat(web): SharePagePrayer component

Renders the title + body + 'From' line + expiry countdown for
corpus and composed_text share kinds."
```

---

## Task 6: SharePageVoice component

Renders the voice playback control for `composed_voice` kind. Falls back to a "Get Union to listen" hint if `audioUrl` is null (audio-signer failed).

**Files:**
- Create: `src/components/SharePageVoice.astro`

- [ ] **Step 1: Create the component**

```astro
---
interface Props {
  audioUrl: string | null
  fromLabel: string | null
  expiresAt: string
}

const { audioUrl, fromLabel, expiresAt } = Astro.props

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  })
}

function daysUntil(iso: string): number {
  return Math.max(
    0,
    Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000),
  )
}

const days = daysUntil(expiresAt)
---

<article class="voice-card">
  <h1>A voice prayer</h1>
  {audioUrl ? (
    <audio controls preload="metadata" src={audioUrl}>
      Your browser does not support audio playback.
    </audio>
  ) : (
    <p class="audio-unavailable">
      We couldn't load the audio just now. Install Union to listen and save it
      to your journal.
    </p>
  )}
  {fromLabel && <p class="from"><em>From {fromLabel}</em></p>}
  <p class="expiry">Expires in {days} day{days === 1 ? '' : 's'} ({formatExpiry(expiresAt)}).</p>
</article>

<style>
  .voice-card {
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    border-radius: 12px;
    padding: 48px 40px;
    margin-bottom: 48px;
  }
  .voice-card h1 {
    font-family: var(--display-font);
    font-size: 36px;
    line-height: 1.1;
    margin: 0 0 24px 0;
    color: var(--ink);
  }
  .voice-card audio {
    width: 100%;
    margin: 16px 0;
  }
  .audio-unavailable {
    color: var(--ink-soft);
    font-style: italic;
  }
  .from {
    margin-top: 24px;
    color: var(--ink-soft);
    font-size: 16px;
  }
  .expiry {
    margin-top: 32px;
    color: var(--ink-mute);
    font-family: var(--ui-font);
    font-size: 14px;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SharePageVoice.astro
git commit -m "feat(web): SharePageVoice component

Renders an <audio controls> player for composed_voice shares.
Falls back to a 'Install Union to listen' card if the audio-URL
signer returned null (network blip / sign failure).
"
```

---

## Task 7: SharePageDead component

The soft "This prayer link is no longer active" surface.

**Files:**
- Create: `src/components/SharePageDead.astro`

- [ ] **Step 1: Create the component**

```astro
---
// Soft dead-state for any share link that's expired, retracted, or
// never existed. Same wording for all three per spec §3 so the
// sender can't infer redemption / probers can't enumerate.
---

<article class="dead-card">
  <h1>This prayer link is no longer active</h1>
  <p>
    The sender may have shared a new link, or the time on this one has run out.
    There's no action to take here — but Union has many prayers ready when you
    need them.
  </p>
</article>

<style>
  .dead-card {
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    border-radius: 12px;
    padding: 48px 40px;
    margin-bottom: 48px;
  }
  .dead-card h1 {
    font-family: var(--display-font);
    font-size: 28px;
    line-height: 1.15;
    margin: 0 0 16px 0;
    color: var(--ink);
  }
  .dead-card p {
    color: var(--ink-soft);
    font-size: 17px;
    line-height: 1.55;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SharePageDead.astro
git commit -m "feat(web): SharePageDead component

Soft 'no longer active' surface. Same copy regardless of why
(expired / retracted / never existed) per spec §3."
```

---

## Task 8: InstallCTAs component

App Store / Play Store cards. No "Save to Union" (deferred per decision 1).

**Files:**
- Create: `src/components/InstallCTAs.astro`

- [ ] **Step 1: Create the component**

```astro
---
// Install CTAs shown on every share page. Per Plan C decision 1,
// the "Save to Union" web-auth flow is deferred — this page is
// read-only for the prayer content. Users install Union and then
// tap the link again; the universal link delivered in Plan B then
// handles save in the native app.
---

<section class="ctas">
  <h2>Save this to your journal in Union</h2>
  <p class="hint">Install Union, then tap the link again on the same device.</p>
  <div class="cards">
    <a class="cta" href="https://apps.apple.com/app/id-PLACEHOLDER">
      <span class="cta-label">Download on the</span>
      <span class="cta-store">App Store</span>
    </a>
    <a class="cta" href="https://play.google.com/store/apps/details?id=app.unionwith">
      <span class="cta-label">Get it on</span>
      <span class="cta-store">Google Play</span>
    </a>
  </div>
</section>

<style>
  .ctas {
    border-top: 1px solid var(--rule);
    padding-top: 48px;
    margin-top: 48px;
  }
  .ctas h2 {
    font-family: var(--display-font);
    font-size: 24px;
    line-height: 1.2;
    margin: 0 0 8px 0;
    color: var(--ink);
  }
  .hint {
    color: var(--ink-soft);
    margin: 0 0 24px 0;
  }
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }
  .cta {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    padding: 16px 24px;
    border-radius: 10px;
    background: var(--ink);
    color: var(--paper);
    text-decoration: none;
    font-family: var(--ui-font);
  }
  .cta-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .cta-store {
    font-size: 18px;
    font-weight: 600;
  }
</style>
```

> **Note:** the App Store ID is a placeholder. Once the iOS app is in TestFlight / App Store review, replace `id-PLACEHOLDER` with the real app ID. The Play Store URL is correct (matches `app.unionwith` in `union-app/app.json`).

- [ ] **Step 2: Commit**

```bash
git add src/components/InstallCTAs.astro
git commit -m "feat(web): InstallCTAs component

App Store + Play Store cards. iOS app ID is a placeholder pending
App Store submission; Android URL is the correct app.unionwith
package."
```

---

## Task 9: ShareMeta component + Layout head slot

Open Graph + Twitter Card meta for rich-preview unfurling in WhatsApp / iMessage / Slack.

**Files:**
- Create: `src/components/ShareMeta.astro`
- Modify: `src/layouts/Layout.astro` (add `<slot name="head" />`)

- [ ] **Step 1: Create ShareMeta**

```astro
---
interface Props {
  title: string
  description: string
}

const { title, description } = Astro.props
---

<meta property="og:type" content="website" />
<meta property="og:title" content={title} />
<meta property="og:description" content={description} />
<meta property="og:site_name" content="Union" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content={title} />
<meta name="twitter:description" content={description} />
```

- [ ] **Step 2: Modify `src/layouts/Layout.astro`**

Find the existing `<head>` block. Add a slot just before the closing `</head>`:

```astro
    <slot name="head" />
  </head>
```

This way pages can inject meta tags (like ShareMeta) without affecting the default ones.

- [ ] **Step 3: Commit**

```bash
git add src/components/ShareMeta.astro src/layouts/Layout.astro
git commit -m "feat(web): ShareMeta + Layout head slot

OG and Twitter Card meta for rich-preview unfurling. Layout
gets a 'head' slot so pages can inject extra meta tags above
the closing </head>."
```

---

## Task 10: AASA file (iOS universal-link verification)

iOS fetches this at app install time AND at first universal-link tap. Without it, taps on `https://unionwith.app/share/<token>` open Safari instead of the app.

**Files:**
- Create: `public/.well-known/apple-app-site-association` (NO `.json` extension — Apple requires it served as the bare filename)

- [ ] **Step 1: Create the file**

`public/.well-known/apple-app-site-association`:

```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "TEAMID.app.unionwith",
        "paths": ["/share/*"]
      }
    ]
  }
}
```

> **CRITICAL:** `TEAMID` is a placeholder — replace with the actual 10-character Apple Team ID before merging. Find it in App Store Connect → Membership, OR by running `xcrun altool --list-providers -u <apple-id>`. Cannot be set in this plan without the credential.

- [ ] **Step 2: Add a Cloudflare Worker route rule so the file is served with `Content-Type: application/json` and no trailing slash redirect**

Modify `wrangler.jsonc` if needed. Cloudflare Workers Static Assets serves files at their exact path; the `.well-known/apple-app-site-association` path should resolve as-is. Verify by building and running `npm run preview`, then `curl -I http://localhost:4321/.well-known/apple-app-site-association` — expect 200 + Content-Type that iOS accepts (Apple is lenient on Content-Type; `text/plain` or `application/json` both work).

- [ ] **Step 3: Commit**

```bash
git add public/.well-known/apple-app-site-association
git commit -m "feat(web): apple-app-site-association for iOS universal links

Declares unionwith.app/share/* as belonging to app.unionwith.
TEAMID placeholder must be replaced with the real Apple Team ID
before merge.

Required by app.json's associatedDomains entry in union-app for
iOS to verify the universal link and route taps into the app."
```

---

## Task 11: Android assetlinks.json

Android verifies the App Links claim against this file at install time.

**Files:**
- Create: `public/.well-known/assetlinks.json`

- [ ] **Step 1: Create the file**

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "app.unionwith",
      "sha256_cert_fingerprints": ["SHA256-FINGERPRINT-PLACEHOLDER"]
    }
  }
]
```

> **CRITICAL:** `SHA256-FINGERPRINT-PLACEHOLDER` is a placeholder — replace with the actual SHA-256 cert fingerprint of the Play Store signing key. Obtain via `eas credentials --platform android` (the EAS-managed signing key) or via Play Console → Release → Setup → App integrity → App signing key certificate → SHA-256.

- [ ] **Step 2: Commit**

```bash
git add public/.well-known/assetlinks.json
git commit -m "feat(web): assetlinks.json for Android App Links

Declares unionwith.app/share/* as belonging to app.unionwith.
SHA-256 cert fingerprint placeholder must be replaced with the
real Play Store signing key fingerprint before merge.

Required by app.json's intentFilters entry in union-app for
Android to auto-verify the App Link and route taps into the app."
```

---

## Task 12: PR + Cloudflare preview verification

Open the PR, watch CI, deploy a preview, manually verify the share/dead/voice paths end-to-end.

- [ ] **Step 1: Run the full test + build cycle locally**

```bash
npm run typecheck
npm test
npm run build
```

All clean.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin feat/shared-prayer-receive-web
gh pr create --title "feat: shared-prayer receive — web (Plan C)" --body "..."
```

PR body references Plan B's universal-link config (#147 merged), Plan A's redeem flow, the precursor share-audio-url PR from Task 1, and flags the AASA / assetlinks placeholders that need real values before merge.

- [ ] **Step 3: Watch the Workers Builds deploy**

Cloudflare creates a preview deployment per PR. Wait for the green check. URL pattern: `https://union-webapp.<hash>.pages.dev` (or the Workers Builds equivalent).

- [ ] **Step 4: Manually verify against the preview URL**

Each scenario, using a real token from the staging Supabase project (mint one via the existing flow):

1. **Alive corpus share** — visit `<preview>/share/<token>`. Confirm: prayer title + body render, From line shows, expiry countdown is right, install CTAs visible.
2. **Alive composed_text share** — same.
3. **Alive composed_voice share** — confirm the `<audio>` element loads and plays the actual audio bytes via the signed URL.
4. **Retracted share** — retract via the app (Plan B's RetractLinkRow), then visit the URL on the preview. Confirm the dead state renders.
5. **Expired share** — wait or hack expires_at down, then visit. Confirm dead state.
6. **Never-existed token** — visit `<preview>/share/aaaaaaaaaa`. Confirm dead state.
7. **Rich preview meta** — paste the share URL into iMessage / WhatsApp / Slack. Confirm the title + description unfurl right.

- [ ] **Step 5: Replace the AASA + assetlinks placeholders**

Per Tasks 10 and 11. These cannot be set until the user provides the Apple Team ID and the Android signing-key SHA-256. Block merge until they're in.

- [ ] **Step 6: Once placeholders are real, merge**

The Cloudflare deploy promotes automatically on merge to main.

---

## Spec coverage self-review

| Spec § | Requirement | Task(s) |
|---|---|---|
| §3 Recipient — without Union, public web page | `/share/[token]` SSR route | Task 4 |
| §3 Public page shows prayer text big | SharePagePrayer component | Task 5 |
| §3 Voice prayer audio playback control | SharePageVoice component | Task 6 |
| §3 "Expires in N days" | Both Prayer + Voice components show it | Tasks 5, 6 |
| §3 "From: Sarah" line | Both components render `fromLabel` | Tasks 5, 6 |
| §3 Install CTA (App Store / Play Store / web app) | InstallCTAs component | Task 8 |
| §3 "Save to Union" CTA | **Deferred — see decision 1** | — |
| §3 Dead state | SharePageDead component | Task 7 |
| §6 Audio served via short-TTL signed URL | share-audio-url edge function (5 min TTL) | Task 1 |
| §6 Public page is uninstrumented | No analytics, no IP logging | (implicit — no code added for it) |
| §9 Dead-state copy identical for expired / retracted / never-existed | SharePageDead renders the same for all three; resolveShareLink returns `{ kind: 'dead' }` for all three | Tasks 3, 7 |
| App.json `applinks:unionwith.app` (Plan B) needs AASA | `public/.well-known/apple-app-site-association` | Task 10 |
| App.json Android intentFilters (Plan B) needs assetlinks | `public/.well-known/assetlinks.json` | Task 11 |

**Gaps surfaced by self-review:**

- **"Save to Union" web auth** is deferred (decision 1). The spec calls for it; Plan C ships without. Flag for follow-up.
- **AASA + assetlinks placeholders** need real Apple Team ID and Android signing fingerprint before merge.
- **App Store URL** placeholder in InstallCTAs needs the real App Store ID once the iOS app is approved.
- **Rich-preview OG image** — none provided. The text-only OG meta will still unfurl, but adding an `<og:image>` would be polished follow-up.
- **Analytics on public page** — Task description says "no IP logging" but doesn't add any code. Should we add a robots `noindex` header for the share pages so they don't end up in search results? Worth a follow-up; the unguessable token URLs are de facto private but a meta robots tag would be belt-and-braces.

---

## Execution

**Plan C complete and saved to** `docs/superpowers/plans/2026-06-06-shared-prayer-receive-web.md`.

Once Plan C merges, the public web fallback is live and iOS universal-link verification will succeed for the `unionwith.app/share/*` claim from Plan B. Plan D (legal updates + cross-repo E2E + Status banner flip) can then start.

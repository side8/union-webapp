import { createClient } from '@supabase/supabase-js'

// Server-side-only Supabase client. This module must never be
// imported into client-bundle code (no React island, no <script>).
// Astro keeps modules imported only from .astro frontmatter on the
// server. The env vars deliberately drop the PUBLIC_ prefix so
// Astro will not expose them to the client.
//
// Anon-only client. The share page is public; no auth, no session.
// RLS on shared_prayer_links ("Shared links: anyone read alive")
// limits anon to alive rows.
const SUPABASE_URL = import.meta.env.SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'SUPABASE_URL / SUPABASE_ANON_KEY not set — copy .env.example to .env or set Worker secrets.',
  )
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

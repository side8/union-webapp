import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Server-side-only Supabase client. This module must never be
// imported into client-bundle code (no React island, no <script>).
// Astro keeps modules imported only from .astro frontmatter on the
// server. The credentials deliberately drop the PUBLIC_ prefix so
// Astro will not expose them to the client.
//
// Anon-only client. The share page is public; no auth, no session.
// RLS on shared_prayer_links ("Shared links: anyone read alive")
// limits anon to alive rows.
//
// This is a factory, not a module-level singleton. In Cloudflare
// Workers the credentials arrive per-request via Secrets Store
// bindings (Astro.locals.runtime.env), not on import.meta.env — so
// the client cannot be built once at module load / build time.
export function createSupabaseClient(
  url: string,
  anonKey: string,
): SupabaseClient {
  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })
}

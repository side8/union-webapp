// @ts-check
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import tailwindcss from '@tailwindcss/vite'

// Hybrid: pages stay statically prerendered (default in Astro 6
// with output:'static') UNLESS they opt out via
//   export const prerender = false
// The share-link route does that — it runs in the Cloudflare
// Worker at request time so each token resolves to the right
// prayer. Marketing pages (home / privacy / terms / support)
// keep their static perf.
//
// @astrojs/cloudflare v13 wires up Cloudflare runtime simulation
// in dev via @cloudflare/vite-plugin automatically; no extra
// platformProxy option is needed (and that option was removed in
// this adapter version).
export default defineConfig({
  output: 'static',
  adapter: cloudflare(),
  vite: {
    plugins: [tailwindcss()],
  },
})

# union-webapp

Marketing site for Union — the prayer companion app (`../union-app`). Hosts the privacy policy, terms, and support pages that Apple App Store Connect (and Google Play later) requires links to.

**Live:** https://unionwith.app (when DNS lands)

## Stack

- [Astro](https://astro.build) — static site generator, ships zero JS by default
- [Tailwind v4](https://tailwindcss.com) — same `union-cream` / `union-charcoal` design tokens as the native app
- Hosted on [Cloudflare Pages](https://pages.cloudflare.com) — free tier covers marketing-site scale; domain is already on Cloudflare so DNS is one-click

## Local development

```bash
npm install
npm run dev
```

Then open <http://localhost:4321>.

## Pages

| Route | Source | Purpose |
|---|---|---|
| `/` | `src/pages/index.astro` | Landing — wordmark, strapline, "in private beta" pointer |
| `/privacy` | `src/pages/privacy.astro` | Privacy policy. Required by App Store Connect. Names the OpenAI/Anthropic data flow per the PII invariant in `union-supabase/checkin/embed.ts` + `score.ts`. |
| `/terms` | `src/pages/terms.astro` | Terms of use. |
| `/support` | `src/pages/support.astro` | Help + contact + crisis-support pointers. Linked from App Store Connect's "Support URL" field. |

All four pages share `src/layouts/Layout.astro` which provides the header (nav) and footer (contact email).

## Deploy

**Cloudflare Pages, native GitHub integration** — push to `main` triggers a build + deploy. No GitHub Action needed.

### One-time setup (manual)

1. Sign in to <https://dash.cloudflare.com> → Workers & Pages → Create application → Pages → "Connect to Git".
2. Authorise GitHub access to `side8/union-webapp`.
3. Build settings:
   - **Framework preset**: Astro
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Root directory**: (leave blank)
4. Deploy. The first build assigns a `*.pages.dev` URL.
5. Custom domain: Pages project → Custom domains → Set up a custom domain → `unionwith.app` (and `www.unionwith.app` if you want). Cloudflare prompts you to confirm the DNS records (they're auto-managed since the domain is already on Cloudflare).
6. SSL: automatic.

After that, every push to `main` rebuilds + redeploys in ~30 seconds. Preview deployments are created for every PR automatically.

## Design tokens

`src/styles/global.css` mirrors `union-app/tailwind.config.js`. When the app's tokens evolve, update them here too so the marketing site stays visually consistent. There's no shared package yet; treat the two surfaces as manually synced.

## Out of scope (deliberately)

- Newsletter signup, beta-waitlist form, analytics, cookie banner, blog, screenshots gallery. Add only when there's a specific reason.

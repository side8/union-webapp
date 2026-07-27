// Cloudflare Email Worker: receives mail for reviewer.play@unionwith.app
// and parks the latest Union sign-in code in KV for the Play reviewer page.
//
// Why a separate Worker rather than part of the Astro app: an Email Worker
// is an entirely different entrypoint (an `email` export, not `fetch`), and
// the Astro Cloudflare adapter owns the generated `fetch` worker. Keeping
// this standalone means the ingress can be deployed and reasoned about on
// its own; the two share only the KV namespace.
//
// unionwith.app already routes mail through Cloudflare Email Routing (its MX
// records point at route*.mx.cloudflare.net), so this needs no MX change —
// only a route in the dashboard sending the reviewer alias to this Worker.
//
// Rationale for the whole mechanism lives in ../../src/lib/reviewer-otp.ts.

import {
  extractOtp,
  REVIEWER_ADDRESS,
  REVIEWER_OTP_KEY,
  REVIEWER_OTP_TTL_SECONDS,
  type StoredOtp,
} from '../../../src/lib/reviewer-otp'

interface Env {
  REVIEWER_OTP: KVNamespace
}

// Cap how much of the message we pull into memory. A Supabase OTP email is
// a couple of KB; anything vastly larger is not our mail and should not be
// allowed to balloon the Worker's memory.
const MAX_BYTES = 256 * 1024

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // Email Routing should only ever deliver the reviewer alias here, but
    // this is a public ingress: re-check rather than trust the routing
    // config, so a future misconfigured catch-all can't publish somebody
    // else's codes on the reviewer page.
    if (message.to.toLowerCase() !== REVIEWER_ADDRESS) {
      console.warn('reviewer-otp: ignoring mail for unexpected recipient')
      return
    }

    if (message.rawSize > MAX_BYTES) {
      console.warn(`reviewer-otp: ignoring oversized message (${message.rawSize}B)`)
      return
    }

    const raw = await new Response(message.raw).text()
    const code = extractOtp(raw)

    // No code found: leave whatever is already in KV untouched. Overwriting
    // a good code with a null would strand the reviewer, and a stale code
    // is at least visibly stale on the page (it shows the age).
    if (!code) {
      console.warn('reviewer-otp: no unambiguous 6-digit code in message')
      return
    }

    const stored: StoredOtp = { code, receivedAt: new Date().toISOString() }
    await env.REVIEWER_OTP.put(REVIEWER_OTP_KEY, JSON.stringify(stored), {
      expirationTtl: REVIEWER_OTP_TTL_SECONDS,
    })

    // Deliberately does not log the code itself — Workers Logs are retained
    // and this address is a live sign-in factor for the demo account.
    console.log('reviewer-otp: stored a fresh sign-in code')
  },
}

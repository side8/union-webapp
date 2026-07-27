// Google Play reviewer sign-in support.
//
// Union has no password: sign-in emails a 6-digit one-time code. Google
// Play review can't work with that — reviewers may not use their own
// accounts, and Play requires sign-in details that are "accessible at all
// times, reusable, and valid regardless of user location", explicitly
// telling developers to supply credentials that BYPASS a one-time PIN.
//
// Play's own escape hatch for a credential that isn't a plain string is a
// static URL. So: reviewer.play@unionwith.app is routed through a
// Cloudflare Email Worker, which parks the latest code in KV, and an
// unguessable page renders it. The reviewer types the email address into
// Union, opens the URL, reads the code. Nothing to expire, no mailbox to
// share, no Google 2-step challenge.
//
// This module is the pure half (parsing + policy) so it is unit-testable
// without a Workers runtime; the Worker and the page are thin shells.

// Single-slot store: the reviewer only ever needs the most recent code.
export const REVIEWER_OTP_KEY = 'latest'

// How long a stored code stays readable. Supabase expires the OTP itself
// well inside this; the TTL exists so a code can never linger in KV after
// it has stopped being useful.
export const REVIEWER_OTP_TTL_SECONDS = 900

// Only mail actually addressed to the reviewer alias is accepted. Email
// Routing should only ever deliver that address here, but the Worker is a
// public ingress point, so it re-checks rather than trusting routing.
export const REVIEWER_ADDRESS = 'reviewer.play@unionwith.app'

export interface StoredOtp {
  code: string
  receivedAt: string
}

// Quoted-printable is the encoding that actually breaks naive parsing:
// it can insert a soft line break ("=\r\n") anywhere, including through
// the middle of the digits, and escapes bytes as "=XX". Undo both before
// looking for the code, or a code split as "12=\r\n3456" is missed.
export function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=(?:\r\n|\n|\r)/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
}

// Pulls the 6-digit sign-in code out of a raw Supabase OTP email.
//
// Deliberately conservative: a raw MIME message is full of six-digit-ish
// noise (dates, message ids, boundary strings, tracking params), so a bare
// \d{6} scan over the whole payload is not safe. Instead we only look at
// the message BODY, skip anything that is part of a longer alphanumeric
// run, and require the match to be a standalone token.
//
// Returns null when no code is found — the caller must not store garbage,
// because a wrong code on the page is worse than an empty page (the
// reviewer would retype it, fail, and likely reject the app).
export function extractOtp(raw: string): string | null {
  // Headers end at the first blank line. Everything before it is metadata
  // (Date:, Message-ID:, DKIM=...) and a rich source of false positives.
  const separator = raw.search(/\r?\n\r?\n/)
  const body = separator === -1 ? raw : raw.slice(separator)

  const decoded = decodeQuotedPrintable(body)

  // A standalone 6-digit run: not preceded or followed by another digit or
  // a word character, which rules out "abc123456", "1234567" and
  // "boundary=--123456xyz".
  const matches = decoded.match(/(?<![A-Za-z0-9])\d{6}(?![A-Za-z0-9])/g)
  if (!matches || matches.length === 0) return null

  // Union's template renders exactly one code. If a future template change
  // makes that ambiguous we would rather show nothing than guess wrong, so
  // only accept an unambiguous result: either a single match, or several
  // matches that agree (the code appearing in both the text and HTML parts
  // of a multipart email is normal and not ambiguity).
  const distinct = [...new Set(matches)]
  return distinct.length === 1 ? distinct[0] : null
}

// Constant-time-ish comparison for the URL secret. Not defending against a
// serious timing attack (the value is a long random string in a URL), but
// avoiding an early-exit compare costs nothing.
export function secretMatches(provided: string, expected: string): boolean {
  if (!expected || provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

// Human-friendly age, so the reviewer can tell a fresh code from a stale
// one at a glance rather than comparing timestamps.
export function describeAge(receivedAt: string, now: Date = new Date()): string {
  const then = new Date(receivedAt).getTime()
  if (Number.isNaN(then)) return 'unknown age'
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ago`
}

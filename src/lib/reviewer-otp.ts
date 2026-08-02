// Store-review and demo sign-in support.
//
// Union has no password: sign-in emails a one-time code (EIGHT digits today
// — see the OTP_MIN/OTP_MAX note below; assuming six broke this in production). Google
// Play review can't work with that — reviewers may not use their own
// accounts, and Play requires sign-in details that are "accessible at all
// times, reusable, and valid regardless of user location", explicitly
// telling developers to supply credentials that BYPASS a one-time PIN.
//
// Play's own escape hatch for a credential that isn't a plain string is a
// static URL. So the addresses below are routed through a Cloudflare Email
// Worker, which parks each one's latest code in KV, and an unguessable page
// renders them. The reader types the email address into Union, opens the
// URL, reads the code. Nothing to expire, no mailbox to share, no Google
// 2-step challenge.
//
// This module is the pure half (parsing + policy) so it is unit-testable
// without a Workers runtime; the Worker and the page are thin shells.

// How long a stored code stays readable. Supabase expires the OTP itself
// well inside this; the TTL exists so a code can never linger in KV after
// it has stopped being useful.
export const REVIEWER_OTP_TTL_SECONDS = 900

// Only mail addressed to one of these is accepted. Email Routing should
// only ever deliver these here, but the Worker is a public ingress point,
// so it re-checks rather than trusting routing — a future misconfigured
// catch-all must not be able to publish somebody else's codes.
//
// Each address gets its OWN slot in KV. A shared slot would mean whichever
// mail arrived last wins, so two people signing in at once would read each
// other's code and both fail — the kind of thing that goes wrong precisely
// when a review is live.
//
// The address doubles as the page's Basic-auth username, so a reader is only
// ever shown the one code that is theirs. See resolveAuthorisedAddress.
export const OTP_ADDRESSES = [
  { address: 'reviewer.apple@unionwith.app' },
  { address: 'reviewer.play@unionwith.app' },
  { address: 'hannah@unionwith.app' },
] as const

// Normalises a recipient for comparison and for use as a KV key.
//
// `message.to` arrives as a bare address in practice, but the header form
// `Display Name <a@b>` exists and a stray one must not slip past the
// allowlist as "unrecognised" — nor become a KV key with angle brackets in
// it. Addresses are case-insensitive in practice for our mail, so fold.
export function normaliseAddress(to: string): string {
  const trimmed = to.trim()
  const angled = /<([^>]*)>\s*$/.exec(trimmed)
  return (angled ? angled[1] : trimmed).trim().toLowerCase()
}

// Whether mail for this recipient should be stored at all.
export function isAllowedAddress(to: string): boolean {
  const normalised = normaliseAddress(to)
  return OTP_ADDRESSES.some((entry) => entry.address === normalised)
}

// The KV key holding the latest code for one address. Single-slot per
// address: only the most recent code is ever wanted.
export function otpKeyFor(address: string): string {
  return `code:${normaliseAddress(address)}`
}

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

// Splits a raw MIME message into decoded body parts.
//
// Real mail is not one flat body. Resend delivers the Supabase OTP as
// multipart/alternative: a text/plain part (8bit) plus a text/html part
// (quoted-printable, whose soft line breaks fall inside style attributes).
// Scanning the raw payload undecoded manufactures spurious digit runs and can
// split the code — captured from production, so this is observed, not assumed.
//
// Returns one decoded string per part.
export function decodeMimeParts(raw: string): string[] {
  const headerEnd = raw.search(/\r?\n\r?\n/)
  const headers = headerEnd === -1 ? '' : raw.slice(0, headerEnd)
  const body = headerEnd === -1 ? raw : raw.slice(headerEnd)

  const boundary = /boundary="?([^"\s;]+)"?/i.exec(headers)?.[1]
  const chunks = boundary
    ? body.split(
        new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      )
    : [raw]

  return chunks
    .map((chunk) => {
      const sep = chunk.search(/\r?\n\r?\n/)
      // No blank line means no part headers — treat the whole chunk as body
      // rather than discarding it, or a payload with no MIME structure at all
      // yields nothing.
      const partHeaders = sep === -1 ? '' : chunk.slice(0, sep).toLowerCase()
      const partBody = sep === -1 ? chunk : chunk.slice(sep)

      if (partHeaders.includes('base64')) {
        try {
          return atob(partBody.replace(/[^A-Za-z0-9+/=]/g, ''))
        } catch {
          // A corrupt part must not cost us the other parts.
          return ''
        }
      }
      // Decode quoted-printable when declared, but ALSO when a soft line break
      // is visibly present: an undeclared one lands mid-digits and silently
      // splits the code.
      if (
        partHeaders.includes('quoted-printable') ||
        /=(?:\r\n|\n)/.test(partBody)
      ) {
        return decodeQuotedPrintable(partBody)
      }
      return partBody
    })
    .filter((s) => s.length > 0)
}

// Supabase's OTP length is CONFIGURABLE (6-10). Union's is currently EIGHT —
// the template reads "Your 8-digit sign-in code:". The first version of this
// parser hard-coded \d{6} and therefore refused every real email with
// "no unambiguous 6-digit code in message": there genuinely wasn't one. The
// range is deliberate so a future retune doesn't break it again.
const OTP_MIN = 6
const OTP_MAX = 10

// A standalone run of OTP-length digits, not adjacent to another digit or
// letter — rules out "abc12345678" and "123456789012".
const OTP_RUN = new RegExp(
  `(?<![A-Za-z0-9])\\d{${OTP_MIN},${OTP_MAX}}(?![A-Za-z0-9])`,
  'g',
)

export function extractOtp(raw: string): string | null {
  const parts = decodeMimeParts(raw)
  if (parts.length === 0) return null

  // Stage 1 — anchored on the template's own wording ("...sign-in code:").
  // Immune to unrelated numbers, which real mail is full of.
  for (const part of parts) {
    // Tags stripped so "code:</p><h1> 49382716" still reads as adjacent text.
    const text = part.replace(/<[^>]*>/g, ' ')
    const anchored = new RegExp(
      `code[^0-9]{0,40}?(\\d{${OTP_MIN},${OTP_MAX}})(?![A-Za-z0-9])`,
      'i',
    ).exec(text)
    if (anchored) return anchored[1]
  }

  // Stage 2 — an unambiguous standalone run. The same code appearing in both
  // the text and HTML parts is agreement, not ambiguity.
  const found = new Set<string>()
  for (const part of parts) {
    for (const m of part.replace(/<[^>]*>/g, ' ').match(OTP_RUN) ?? []) {
      found.add(m)
    }
  }
  return found.size === 1 ? [...found][0] : null
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

export interface BasicCredentials {
  user: string
  pass: string
}

// Parses an HTTP Basic `Authorization` header into its two halves.
//
// Basic auth is the right shape for this page: Play's App access form has
// literal Username and Password fields, and a browser renders the prompt
// natively so there is no login form to build or session to manage. Over
// HTTPS the credentials are protected in transit.
//
// Returns null for anything malformed rather than throwing — a hostile or
// broken header must produce a clean 401, not a 500.
export function parseBasicAuth(header: string | null): BasicCredentials | null {
  if (!header) return null

  // Scheme is case-insensitive per RFC 7617, and exactly one space.
  const match = /^Basic\s+(\S+)$/i.exec(header.trim())
  if (!match) return null

  let decoded: string
  try {
    decoded = atob(match[1])
  } catch {
    // Not valid base64.
    return null
  }

  // Only the FIRST colon separates the two fields — a password may itself
  // contain colons, and splitting on all of them would silently truncate it
  // (and could let a wrong password compare equal to a shortened one).
  const separator = decoded.indexOf(':')
  if (separator === -1) return null

  return {
    user: decoded.slice(0, separator),
    pass: decoded.slice(separator + 1),
  }
}

// Resolves an Authorization header to the ONE address whose code the caller
// may read, or null.
//
// The username IS the email address being signed in with — the same string
// the reviewer types on Union's sign-in screen, so there is nothing extra to
// remember and no way to read the code off the wrong row. The page then
// shows that address alone.
//
// This deliberately moves the username from "a secret" to "an identifier".
// The guarding is done by the two things that remain secret: the unguessable
// URL token (a wrong one 404s before the prompt) and the shared password.
// What it buys is that three parties can be handed the same link and each
// sees only their own code.
//
// Fails CLOSED: an unset password makes secretMatches reject everything, so
// a half-configured deploy leaves the page locked rather than open.
export function resolveAuthorisedAddress(
  header: string | null,
  expectedPass: string,
): string | null {
  const provided = parseBasicAuth(header)
  if (!provided) return null

  // Both checks always run — no short-circuit on the username, so the
  // response time doesn't reveal which half was wrong.
  const passOk = secretMatches(provided.pass, expectedPass)
  const normalised = normaliseAddress(provided.user)
  const known = OTP_ADDRESSES.find((entry) => entry.address === normalised)

  return passOk && known ? known.address : null
}

// Whether to reject an otherwise-valid request in order to re-prompt.
//
// HTTP Basic has no sign-out: the browser caches the credentials and
// re-sends them unasked, and no response header reliably clears them. The
// only lever is to answer 401, which makes the browser ask again.
//
// Done naively that loops forever — the browser supplies the NEW credentials
// and a "always 401 here" endpoint rejects those too. So the link carries the
// address being left (`?switch=<address>`) and this returns true only while
// the request still presents THAT address. Supply a different one and it
// authorises immediately. Stateless, and it terminates.
//
// A reviewer never needs this; it exists because one person holds all three
// identities and has to move between them.
export function shouldForceReprompt(
  switchingFrom: string | null,
  presentedUser: string | null,
): boolean {
  if (!switchingFrom || presentedUser === null) return false
  return normaliseAddress(presentedUser) === normaliseAddress(switchingFrom)
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

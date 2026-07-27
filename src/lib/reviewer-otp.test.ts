import { describe, expect, it } from 'vitest'
import {
  basicAuthOk,
  decodeQuotedPrintable,
  describeAge,
  extractOtp,
  parseBasicAuth,
  secretMatches,
} from './reviewer-otp'

// The stakes here are asymmetric: showing NO code makes the reviewer wait
// a moment and reload; showing the WRONG code makes them fail sign-in and
// very likely reject the app. So the tests lean hard on "returns null when
// unsure" rather than "always finds something".

const HEADERS = [
  'Received: from mail.supabase.io (10.0.0.1) by mx.cloudflare.net;',
  'Date: Mon, 27 Jul 2026 09:15:00 +0000',
  'Message-ID: <209431.847216@supabase.io>',
  'To: reviewer.play@unionwith.app',
  'Subject: Your Union sign-in code',
  'Content-Type: text/plain; charset=UTF-8',
].join('\r\n')

function email(body: string, headers = HEADERS): string {
  return `${headers}\r\n\r\n${body}`
}

describe('extractOtp', () => {
  it('pulls the code out of a plain-text Supabase OTP email', () => {
    expect(extractOtp(email('One time login code\r\n\r\n482913\r\n'))).toBe(
      '482913',
    )
  })

  it('finds the code when it is inline in a sentence', () => {
    expect(
      extractOtp(email('Please enter this code: 130456 to sign in.')),
    ).toBe('130456')
  })

  // Headers are dense with six-digit noise — Message-ID above contains
  // both "209431" and "847216". Scanning the whole message would return
  // one of those instead of the real code.
  it('ignores six-digit runs in the headers', () => {
    const result = extractOtp(email('Your code is 555111'))
    expect(result).toBe('555111')
  })

  it('returns null when the body has no code at all', () => {
    expect(extractOtp(email('Welcome to Union. Nothing to do here.'))).toBe(
      null,
    )
  })

  // A multipart email repeats the code in the text and HTML parts. That is
  // agreement, not ambiguity, and must still resolve.
  it('accepts the same code repeated across multipart sections', () => {
    const body = [
      '--boundary',
      'Content-Type: text/plain',
      '',
      'Your code: 246810',
      '--boundary',
      'Content-Type: text/html',
      '',
      '<p>Your code: <b>246810</b></p>',
      '--boundary--',
    ].join('\r\n')
    expect(extractOtp(email(body))).toBe('246810')
  })

  // If a template change ever puts two DIFFERENT six-digit numbers in the
  // body we cannot know which is the code, so we must refuse rather than
  // guess and hand the reviewer a failing code.
  it('returns null when two different six-digit values compete', () => {
    expect(extractOtp(email('Code 111222, ref 333444'))).toBe(null)
  })

  it('does not match digits embedded in a longer run', () => {
    expect(extractOtp(email('order 1234567 shipped'))).toBe(null)
    expect(extractOtp(email('token abc123456def'))).toBe(null)
  })

  it('does not match five or seven digit values', () => {
    expect(extractOtp(email('pin 12345'))).toBe(null)
    expect(extractOtp(email('pin 1234567'))).toBe(null)
  })

  // The real-world failure mode: quoted-printable inserts a soft break
  // through the middle of the digits.
  it('finds a code split across a quoted-printable soft line break', () => {
    expect(extractOtp(email('Your code is 48=\r\n2913 — enter it soon'))).toBe(
      '482913',
    )
  })

  it('handles a message with no header/body separator at all', () => {
    expect(extractOtp('482913')).toBe('482913')
  })
})

describe('decodeQuotedPrintable', () => {
  it('removes soft line breaks', () => {
    expect(decodeQuotedPrintable('abc=\r\ndef')).toBe('abcdef')
  })

  it('decodes escaped bytes', () => {
    expect(decodeQuotedPrintable('caf=C3=A9')).toBe('cafÃ©')
  })
})

describe('secretMatches', () => {
  it('accepts an exact match', () => {
    expect(secretMatches('s3cr3t-token', 's3cr3t-token')).toBe(true)
  })

  it('rejects a mismatch, a prefix, and a different length', () => {
    expect(secretMatches('nope', 's3cr3t-token')).toBe(false)
    expect(secretMatches('s3cr3t', 's3cr3t-token')).toBe(false)
    expect(secretMatches('s3cr3t-token-x', 's3cr3t-token')).toBe(false)
  })

  // If the secret was never configured, an empty guess must NOT sail
  // through and expose the page.
  it('rejects everything when no secret is configured', () => {
    expect(secretMatches('', '')).toBe(false)
    expect(secretMatches('anything', '')).toBe(false)
  })
})

describe('parseBasicAuth', () => {
  const encode = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`

  it('splits a well-formed header', () => {
    expect(parseBasicAuth(encode('reviewer', 'hunter2'))).toEqual({
      user: 'reviewer',
      pass: 'hunter2',
    })
  })

  it('accepts the scheme case-insensitively (RFC 7617)', () => {
    expect(parseBasicAuth(`basic ${btoa('a:b')}`)).toEqual({
      user: 'a',
      pass: 'b',
    })
  })

  // A password containing a colon must survive intact. Splitting on every
  // colon would truncate it — and a truncated password could compare equal
  // to a shorter wrong one.
  it('only splits on the first colon so colons in the password survive', () => {
    expect(parseBasicAuth(encode('reviewer', 'a:b:c'))).toEqual({
      user: 'reviewer',
      pass: 'a:b:c',
    })
  })

  it('allows an empty password', () => {
    expect(parseBasicAuth(encode('reviewer', ''))).toEqual({
      user: 'reviewer',
      pass: '',
    })
  })

  it('returns null for malformed input rather than throwing', () => {
    expect(parseBasicAuth(null)).toBe(null)
    expect(parseBasicAuth('')).toBe(null)
    expect(parseBasicAuth('Bearer abc')).toBe(null)
    expect(parseBasicAuth('Basic')).toBe(null)
    expect(parseBasicAuth('Basic !!!not-base64!!!')).toBe(null)
    // Valid base64, but no colon to split on.
    expect(parseBasicAuth(`Basic ${btoa('nocolon')}`)).toBe(null)
  })
})

describe('basicAuthOk', () => {
  const header = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`

  it('accepts the configured credentials', () => {
    expect(basicAuthOk(header('reviewer', 'sekrit'), 'reviewer', 'sekrit')).toBe(
      true,
    )
  })

  it('rejects a wrong password, wrong user, or missing header', () => {
    expect(basicAuthOk(header('reviewer', 'nope'), 'reviewer', 'sekrit')).toBe(
      false,
    )
    expect(basicAuthOk(header('someone', 'sekrit'), 'reviewer', 'sekrit')).toBe(
      false,
    )
    expect(basicAuthOk(null, 'reviewer', 'sekrit')).toBe(false)
  })

  // The important one: a half-configured deploy must LOCK the page, not
  // open it. An unset password with an empty guess must still fail.
  it('fails closed when the expected credentials are unset', () => {
    expect(basicAuthOk(header('reviewer', ''), 'reviewer', '')).toBe(false)
    expect(basicAuthOk(header('', ''), '', '')).toBe(false)
    expect(basicAuthOk(header('reviewer', 'sekrit'), '', '')).toBe(false)
  })
})

describe('describeAge', () => {
  const now = new Date('2026-07-27T09:15:00Z')

  it('reports seconds under a minute', () => {
    expect(describeAge('2026-07-27T09:14:30Z', now)).toBe('30s ago')
  })

  it('reports whole minutes past a minute', () => {
    expect(describeAge('2026-07-27T09:10:00Z', now)).toBe('5m ago')
  })

  it('never reports a negative age from clock skew', () => {
    expect(describeAge('2026-07-27T09:20:00Z', now)).toBe('0s ago')
  })

  it('degrades gracefully on an unparseable timestamp', () => {
    expect(describeAge('not-a-date', now)).toBe('unknown age')
  })
})

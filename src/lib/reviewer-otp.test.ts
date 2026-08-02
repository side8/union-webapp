import { describe, expect, it } from 'vitest'
import {
  decodeQuotedPrintable,
  describeAge,
  extractOtp,
  isAllowedAddress,
  normaliseAddress,
  OTP_ADDRESSES,
  otpKeyFor,
  parseBasicAuth,
  resolveAuthorisedAddress,
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

  // Headers are dense with digit noise — Message-ID above contains
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

  // A LABELLED value beats counting distinct runs — and it has to, because real
  // magic-link mail always carries extra ids. (This expectation changed
  // deliberately; the original refused here, which is why production failed.)
  it('prefers the value labelled as the code over other digit runs', () => {
    expect(extractOtp(email('Code 111222, ref 333444'))).toBe('111222')
  })

  // With no label, competing values are genuinely ambiguous: still refuse.
  it('returns null when unlabelled digit runs compete', () => {
    expect(extractOtp(email('Reference 111222, batch 333444'))).toBe(null)
  })

  it('does not match digits welded to letters', () => {
    expect(extractOtp(email('token abc12345678def'))).toBe(null)
  })

  // Boundaries of the accepted range. Union's code is 8 digits and the length
  // is a Supabase setting (6-10), so 7 is a legitimate candidate, not noise.
  it('accepts any length within the configurable OTP range', () => {
    expect(extractOtp(email('pin 1234567'))).toBe('1234567')
    expect(extractOtp(email('pin 1234567890'))).toBe('1234567890')
  })

  it('rejects runs outside the OTP range', () => {
    expect(extractOtp(email('pin 12345'))).toBe(null)
    expect(extractOtp(email('pin 123456789012'))).toBe(null)
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

// THE fixture that matters: a faithful reproduction of what Resend actually
// delivers, captured from production via digit-masked diagnostic logging.
//
// Two parser versions passed synthetic fixtures and failed this, for one
// reason: Union's code is EIGHT digits ("Your 8-digit sign-in code:") and the
// parser hard-coded \d{6}. It found no 6-digit run because there wasn't one,
// and correctly refused. The refusal logic was right; the length was wrong.
//
// Real quirks preserved deliberately: nodemailer boundary, 8bit plain part,
// quoted-printable HTML part whose soft line break falls INSIDE a style
// attribute, and 2-3 digit CSS values that must not be read as a code.
const REAL_EMAIL = [
  'From: noreply@send.unionwith.app',
  'To: reviewer.play@unionwith.app',
  'Subject: Sign in to Union',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative;',
  ' boundary="--_NmP-1234567ae8ddccfb-Part_1"',
  '',
  '----_NmP-1234567ae8ddccfb-Part_1',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  'SIGN IN TO UNION',
  '',
  'Your 8-digit sign-in code:',
  '',
  '49382716',
  '',
  "If you didn't request this, you can safely ignore this email.",
  '----_NmP-1234567ae8ddccfb-Part_1',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<h2>Sign in to Union</h2>',
  '',
  '  <p>Your 8-digit sign-in code:</p>',
  "  <p style=3D\"font-size:32px;letter-spacing:12px;font-family:'Courier New',=",
  'monospace;font-weight:bold;margin:16px 0;">',
  '    49382716',
  '  </p>',
  '',
  '  <p style=3D"color:#ccc;font-size:12px;margin-top:24px;">',
  "    If you didn't request this, you can safely ignore this email.",
  '  </p>',
  '',
  '----_NmP-1234567ae8ddccfb-Part_1--',
].join('\r\n')

describe('extractOtp — the real Resend/Supabase email', () => {
  it('extracts the 8-digit code from the actual delivered message', () => {
    expect(extractOtp(REAL_EMAIL)).toBe('49382716')
  })

  it('reads the code, not the CSS numbers around it', () => {
    // 32, 12, 16, 24 and #ccc all appear as style values.
    expect(extractOtp(REAL_EMAIL)).toHaveLength(8)
  })

  // The length is a Supabase setting. If it is retuned, the parser must follow
  // rather than silently refuse every email again.
  it('follows the template if the length changes to 6 digits', () => {
    const six = REAL_EMAIL.replace(/49382716/g, '405913').replace(
      /8-digit/g,
      '6-digit',
    )
    expect(extractOtp(six)).toBe('405913')
  })
})

describe('extractOtp — other MIME shapes', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

  it('handles a base64-encoded HTML part', () => {
    const raw = [
      'To: reviewer.play@unionwith.app',
      'Content-Type: multipart/alternative; boundary="bnd1"',
      '',
      '--bnd1',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: base64',
      '',
      b64('<p>Your 8-digit sign-in code:</p><b>81726354</b>'),
      '--bnd1--',
    ].join('\r\n')
    expect(extractOtp(raw)).toBe('81726354')
  })

  it('survives a corrupt part without losing a good one', () => {
    const raw = [
      'To: reviewer.play@unionwith.app',
      'Content-Type: multipart/alternative; boundary="bnd2"',
      '',
      '--bnd2',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: base64',
      '',
      '!!!! not base64 !!!!',
      '--bnd2',
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: 8bit',
      '',
      'Your 8-digit sign-in code: 24680246',
      '--bnd2--',
    ].join('\r\n')
    expect(extractOtp(raw)).toBe('24680246')
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

describe('resolveAuthorisedAddress', () => {
  const header = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`
  const PASS = 'sekrit'

  it('resolves each allowlisted address from its own username', () => {
    for (const { address } of OTP_ADDRESSES) {
      expect(resolveAuthorisedAddress(header(address, PASS), PASS)).toBe(address)
    }
  })

  // This is the whole point of keying on the username: three parties share
  // one link and one password, and each is shown only their own code.
  it('never resolves one address from another address’s username', () => {
    const [apple, play] = OTP_ADDRESSES
    expect(resolveAuthorisedAddress(header(apple.address, PASS), PASS)).not.toBe(
      play.address,
    )
  })

  it('normalises the username the same way the Worker does', () => {
    // Otherwise a reviewer who types their address with a capital, or whose
    // browser sends the display-name form, gets a 401 with correct details.
    expect(
      resolveAuthorisedAddress(header(' Hannah@UnionWith.app ', PASS), PASS),
    ).toBe('hannah@unionwith.app')
  })

  it('rejects a wrong password, an unknown username, or no header', () => {
    const known = OTP_ADDRESSES[0].address
    expect(resolveAuthorisedAddress(header(known, 'nope'), PASS)).toBe(null)
    expect(
      resolveAuthorisedAddress(header('duncan@unionwith.app', PASS), PASS),
    ).toBe(null)
    expect(resolveAuthorisedAddress(null, PASS)).toBe(null)
  })

  // The important one: a half-configured deploy must LOCK the page, not
  // open it. An unset password with an empty guess must still fail.
  it('fails closed when the expected password is unset', () => {
    const known = OTP_ADDRESSES[0].address
    expect(resolveAuthorisedAddress(header(known, ''), '')).toBe(null)
    expect(resolveAuthorisedAddress(header(known, 'anything'), '')).toBe(null)
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

describe('OTP_ADDRESSES', () => {
  // These three are what the page renders and the Worker accepts. Losing
  // one silently means a reviewer sits in front of a page that never shows
  // their code, with nothing failing anywhere to say why.
  it('covers the three addresses that need codes', () => {
    expect(OTP_ADDRESSES.map((e) => e.address)).toEqual([
      'reviewer.apple@unionwith.app',
      'reviewer.play@unionwith.app',
      'hannah@unionwith.app',
    ])
  })

  // isAllowedAddress and otpKeyFor both fold case, so an entry stored with
  // a capital would be unreachable: allowed on the way in, looked up under
  // a key nothing ever wrote.
  it('is stored already normalised', () => {
    for (const { address } of OTP_ADDRESSES) {
      expect(address).toBe(normaliseAddress(address))
    }
  })

  it('gives every address its own slot', () => {
    const keys = OTP_ADDRESSES.map((e) => otpKeyFor(e.address))
    expect(new Set(keys).size).toBe(OTP_ADDRESSES.length)
  })

  // The address doubles as the page's Basic-auth username, so it has to be
  // something a reviewer can be told to type — which it is, because it is
  // the same string they already type on Union's sign-in screen.
  it('uses addresses that are usable as usernames', () => {
    for (const { address } of OTP_ADDRESSES) {
      expect(address).toMatch(/^[^\s:]+@[^\s:]+$/)
    }
  })
})

describe('normaliseAddress', () => {
  it('folds case and trims', () => {
    expect(normaliseAddress('  Hannah@UnionWith.app \r\n')).toBe(
      'hannah@unionwith.app',
    )
  })

  // `message.to` is a bare address in practice, but the display-name form
  // exists. Left unhandled it would fail the allowlist AND, if it somehow
  // got through, become a KV key with angle brackets in it.
  it('unwraps a display-name form', () => {
    expect(normaliseAddress('Hannah Reed <hannah@unionwith.app>')).toBe(
      'hannah@unionwith.app',
    )
  })

  it('leaves an ordinary address alone', () => {
    expect(normaliseAddress('hannah@unionwith.app')).toBe(
      'hannah@unionwith.app',
    )
  })
})

describe('isAllowedAddress', () => {
  it('accepts each allowlisted address', () => {
    for (const { address } of OTP_ADDRESSES) {
      expect(isAllowedAddress(address)).toBe(true)
    }
  })

  it('accepts them regardless of case or surrounding whitespace', () => {
    expect(isAllowedAddress(' REVIEWER.PLAY@unionwith.app ')).toBe(true)
  })

  // The Worker is a public ingress. A misconfigured catch-all route must
  // not be able to publish a real person's sign-in code on this page.
  it('rejects anything else, including near-misses', () => {
    expect(isAllowedAddress('duncan@unionwith.app')).toBe(false)
    expect(isAllowedAddress('hannah@unionwith.app.evil.com')).toBe(false)
    expect(isAllowedAddress('hannah@example.com')).toBe(false)
    expect(isAllowedAddress('')).toBe(false)
  })

  // Plus-addressing is a different mailbox as far as this allowlist is
  // concerned — and accepting it would let anyone who can send mail to
  // hannah+anything@ overwrite the real slot.
  it('rejects a plus-addressed variant', () => {
    expect(isAllowedAddress('hannah+test@unionwith.app')).toBe(false)
  })
})

describe('otpKeyFor', () => {
  it('namespaces the key by address', () => {
    expect(otpKeyFor('hannah@unionwith.app')).toBe('code:hannah@unionwith.app')
  })

  // The Worker writes from `message.to` and the page reads from the
  // constant. If those two normalised differently the page would show
  // "No code yet" forever while KV quietly held the code.
  it('derives the same key from a raw recipient and the constant', () => {
    expect(otpKeyFor(' Hannah Reed <Hannah@UnionWith.app> ')).toBe(
      otpKeyFor('hannah@unionwith.app'),
    )
  })
})

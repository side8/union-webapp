// Fails the build if any rendered page has a word glued straight onto an
// inline tag — "and tapDelete Account", "write toprivacy@unionwith.app".
//
// Run:  node scripts/check-html-spacing.mjs      (after `npm run build`)
//
// WHY THIS EXISTS
//
// Astro source like this looks completely fine:
//
//     Sign into the app, head to <strong>Settings</strong>, and tap
//     <strong>Delete Account</strong>.
//
// A browser renders the newline between "and tap" and <strong> as a space, so
// `npm run build` output looks correct locally. But the DEPLOYED HTML is
// minified, and minification collapses that newline to NOTHING — so production
// reads "and tapDelete Account" while local looks perfect.
//
// That is why it survived review: the defect is invisible unless you read the
// deployed HTML. It was live on /support, /terms and /delete-account
// simultaneously, in copy written weeks apart, because nothing checked for it.
//
// THE RULE: never rely on a line break to provide a space before an inline tag.
// Keep the space and the opening tag on the same source line:
//
//     ..., and
//     tap <strong>Delete Account</strong>.      <-- space is explicit
//
// This scans the BUILT output rather than the source, because the built output
// is what ships and the source reads as correct either way.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'dist'

// Inline elements that sit mid-sentence. Block elements (p, div, li, h2)
// legitimately abut text, so they are not listed. <span> is deliberately
// EXCLUDED: it is routinely used for glyph and decoration effects where no
// space is wanted — the homepage wordmark renders "Union<span class=ph-dot>"
// on purpose.
const INLINE = ['a', 'strong', 'em', 'b', 'i', 'code', 'abbr']

// Two shapes of the same defect, because local and deployed HTML differ:
//
//   ALREADY COLLAPSED — "and tap<strong>": what the minified, deployed page
//   looks like. Catches the bug if this ever runs against real output.
//
//   ABOUT TO COLLAPSE — "and tap\n<strong>": what `npm run build` produces
//   locally. A browser renders that newline as a space, so it LOOKS fine — but
//   minification strips it and production breaks. This is the one that matters
//   for catching the bug before it ships, and the reason checking only the
//   collapsed form would pass locally while still shipping broken copy.
const TAGS = INLINE.join('|')
const PATTERNS = [
  { name: 'glued', re: new RegExp(`[A-Za-z,;:]<(${TAGS})[ >]`, 'g') },
  { name: 'newline-before-tag', re: new RegExp(`[A-Za-z,;:]\\n\\s*<(${TAGS})[ >]`, 'g') },
]

function htmlFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p))
    else if (entry.endsWith('.html')) out.push(p)
  }
  return out
}

let files
try {
  files = htmlFiles(ROOT)
} catch {
  console.error(`✘ ${ROOT}/ not found — run \`npm run build\` first.`)
  process.exit(1)
}

if (files.length === 0) {
  console.error(`✘ no HTML found under ${ROOT}/ — did the build succeed?`)
  process.exit(1)
}

let failures = 0
for (const file of files) {
  const html = readFileSync(file, 'utf8')
  const seen = new Set()
  for (const { re } of PATTERNS)
  for (const m of html.matchAll(re)) {
    if (seen.has(m.index)) continue
    seen.add(m.index)
    // Show surrounding text so the offending copy is identifiable, not just
    // the tag name.
    const context = html
      .slice(Math.max(0, m.index - 45), m.index + m[0].length + 25)
      .replace(/\s+/g, ' ')
    console.error(`✘ ${file}\n    …${context}…`)
    failures++
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} missing space(s) before an inline tag.\n` +
      'Keep the space and the opening tag on the SAME source line — a line\n' +
      'break there survives local build but is stripped by minification.',
  )
  process.exit(1)
}

console.log(`✓ no glued inline tags across ${files.length} rendered page(s)`)

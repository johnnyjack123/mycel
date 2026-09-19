/**
 * Minimal glob support for the exclude list: `*` inside a path segment, `**`
 * across segments. Deliberately its own module with no Obsidian import, so it
 * can be tested outside the app.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  // One pass, so `**` is never re-examined by the `*` rule and no placeholder
  // character has to be smuggled through the string.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*|\*/g, (match) => (match === '**' ? '.*' : '[^/]*'))
  return new RegExp(`^${escaped}$`).test(path)
}

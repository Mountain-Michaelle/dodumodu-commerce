/** Dodumodu email brand constants — single source of truth for email styling.
 * Mirrors dodumodu_site/shared/styles/tokens.css. Values are hardcoded hex
 * because email clients cannot reference CSS variables from external stylesheets. */
export const EMAIL_BRAND = {
  bg: '#fff8f5',
  surface: '#ffffff',
  text: '#2b2320',
  muted: '#6b5f59',
  primary: '#00352a',
  primaryDark: '#084d02',
  /** Dark green background of the OTP code block. */
  accent: '#00352a',
  /** Orange text colour used for the code on top of `accent`. */
  onAccent: '#F7A21B',
  border: '#ece1db',
  font: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  /** Monospace stack for codes. Kept separate from `font` so it is never
   * concatenated into a style attribute as a bare, invalid fragment. */
  mono: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, 'Courier New', monospace",
} as const;
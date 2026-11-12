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
  accent: '#00352a',
  border: '#ece1db',
  font: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
} as const;
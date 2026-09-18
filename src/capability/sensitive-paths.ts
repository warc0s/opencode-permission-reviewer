/*
 * Shared credential-path matching for the bash capability analyzer.
 *
 * Covers the union of the literal path patterns already used by the
 * emergency brake and the SSH evidence filter: private keys, credential
 * files, and well-known secret locations. The brake and the SSH filter keep
 * their own copies so their pinned behavior never changes; this module is
 * the shared helper for new deterministic signals.
 */

/** Credential locations as literal path fragments (case-insensitive). */
const SENSITIVE_PATH =
  /(?:^|\/)(?:\.env(?:\.|$)|\.ssh(?:\/|$)|\.aws(?:\/|$)|\.config\/gcloud(?:\/|$)|\.config\/gh\/hosts\.yml$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|credentials(?:\.json)?$|authorized_keys$|known_hosts$|\.npmrc$|\.pypirc$|\.netrc$)/i

/** Suffixes that mark a path as a non-secret example or public artifact. */
const NON_SECRET_SUFFIX = /\.(?:example|sample|template|dist|pub)$/i

/**
 * Test a literal path token (quotes already removed by the lexer) for a
 * credential-path match. Example and public-key suffixes never match.
 */
export function isSensitivePathToken(path: string): boolean {
  if (!path) return false
  if (NON_SECRET_SUFFIX.test(path)) return false
  return SENSITIVE_PATH.test(path)
}

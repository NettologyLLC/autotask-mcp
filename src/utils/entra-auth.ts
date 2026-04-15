/**
 * Entra ID (Azure AD) OAuth helpers for the MCP HTTP server.
 *
 * Provides:
 *   - oauth-protected-resource metadata (RFC 9728) so MCP clients can
 *     discover the Entra ID authorization server via "click Connect".
 *   - JWT Bearer token validation against Entra ID's JWKS endpoint.
 *
 * All behaviour is gated on ENTRA_TENANT_ID being set.  When the env var
 * is absent the helpers are no-ops, so the original repo can be used
 * without any Azure configuration.
 *
 * Merge notes: this file is fork-only and will never conflict upstream.
 * The two call sites in server.ts are clearly marked with ENTRA_AUTH comments.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TENANT_ID = process.env.ENTRA_TENANT_ID;
const CLIENT_ID = process.env.ENTRA_CLIENT_ID;
const SERVER_URL = process.env.MCP_SERVER_URL;

/** True when Entra ID auth is configured. */
export const entraAuthEnabled = Boolean(TENANT_ID && CLIENT_ID);

// Lazily-initialised JWKS client — one instance shared across requests.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`)
    );
  }
  return _jwks;
}

/**
 * Serve /.well-known/oauth-protected-resource
 * Points MCP clients at the Entra ID authorization server for this tenant.
 * Must be called on unauthenticated requests (before any auth check).
 */
export function serveOAuthMetadata(req: IncomingMessage, res: ServerResponse): void {
  const resource = SERVER_URL || `https://${req.headers.host}`;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    resource,
    authorization_servers: [
      `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    ],
    scopes_supported: [`api://${CLIENT_ID}/use`],
    bearer_methods_supported: ['header'],
  }));
}

/**
 * Validate the Bearer token on an incoming request.
 * Returns null on success, or an error message string on failure.
 * When Entra ID auth is not configured always returns null (no-op).
 */
export async function validateBearerToken(req: IncomingMessage): Promise<string | null> {
  if (!entraAuthEnabled) return null;

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return 'Missing Bearer token';
  }

  try {
    const token = authHeader.slice(7);
    await jwtVerify(token, getJwks(), {
      issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      audience: `api://${CLIENT_ID}`,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid token';
  }
}

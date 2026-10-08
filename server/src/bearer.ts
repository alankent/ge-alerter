import type { NextFunction, Request, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Config } from './config.js';
import { sha256 } from './crypto.js';
import type { Store } from './store/types.js';

export type AuthedRequest = Request & { auth?: AuthInfo };

export function userIdFrom(auth: AuthInfo | undefined): string {
  const uid = auth?.extra?.uid;
  if (typeof uid !== 'string' || !uid) throw new Error('request is not authenticated');
  return uid;
}

/**
 * Validates `Authorization: Bearer <access token>` against the store and
 * attaches an MCP-style AuthInfo (with the user id in `extra.uid`) to the
 * request, which the MCP transport forwards to tool handlers.
 */
export function bearerAuth(config: Config, store: Store) {
  const challenge = (res: Response, error: string, description: string, status = 401) => {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="agent-notifications", error="${error}", error_description="${description}", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`,
    );
    res.status(status).json({ error, error_description: description });
  };

  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    if (!header.toLowerCase().startsWith('bearer ')) {
      return challenge(res, 'invalid_token', 'Missing bearer token');
    }
    const token = header.slice(7).trim();
    try {
      const record = await store.getAccessToken(sha256(token));
      if (!record) return challenge(res, 'invalid_token', 'Unknown access token');
      if (record.exp < Date.now()) return challenge(res, 'invalid_token', 'Access token expired');
      req.auth = {
        token,
        clientId: record.clientId,
        scopes: record.scope ? record.scope.split(' ') : [],
        expiresAt: Math.floor(record.exp / 1000),
        extra: { uid: record.uid },
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

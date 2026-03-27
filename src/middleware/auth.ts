import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const CTX = 'Auth';

export const SESSION_COOKIE = 'mailx_session';
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// In-memory session store
const sessions = new Map<string, { createdAt: number }>();

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((c) => {
    const [key, ...val] = c.trim().split('=');
    cookies[key] = val.join('=');
  });
  return cookies;
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function createSession(): string {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Strict`;
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`;
}

/** Middleware: requer sessão válida. Redireciona para /admin/login se não autenticado. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];

  if (!isValidSession(token)) {
    logger.warn(CTX, `Unauthorized access to ${req.path}`);
    // JSON endpoints retornam 401; HTML redireciona para login
    if (req.headers.accept?.includes('application/json') || req.xhr) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      res.redirect('/admin/login');
    }
    return;
  }

  next();
}

export function verifyAdminPassword(password: string): boolean {
  return password === env.ADMIN_PASSWORD;
}

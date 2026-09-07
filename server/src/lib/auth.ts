import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export interface AuthUser {
  id: string;
  username: string;
  role: 'owner' | 'cashier';
  full_name: string | null;
}

// Расширяем Request полем user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}

export function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
}

// Проверка токена. Подтягиваем актуального пользователя (роль/блокировка могли измениться).
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthUser;
    const rows = await query(
      `SELECT id, username, role, full_name, is_blocked FROM users WHERE id = $1`,
      [payload.id],
    );
    const u = rows[0];
    if (!u || u.is_blocked) return res.status(401).json({ error: 'blocked_or_gone' });
    req.user = { id: u.id, username: u.username, role: u.role, full_name: u.full_name };
    next();
  } catch {
    return res.status(401).json({ error: 'bad_token' });
  }
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'owner_only' });
  next();
}

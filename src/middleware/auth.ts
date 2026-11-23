import { NextFunction, Request, Response } from 'express';
import { Role, User } from '../models';
import { HttpError } from '../utils/http';
import { AuthPayload, verifyToken } from '../utils/jwt';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthPayload;
  }
}

export const authenticate = async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(new HttpError(401, 'Missing token'));
  try {
    const payload = verifyToken(header.slice(7));
    // A suspended or removed account loses access immediately, not when its token expires.
    const user = await User.findById(payload.userId).select('status role').lean();
    if (!user) return next(new HttpError(401, 'Invalid or expired token'));
    if (user.status !== 'ACTIVE') return next(new HttpError(403, `Your account is ${user.status.toLowerCase()}`));
    req.auth = { userId: payload.userId, role: user.role as Role };
    next();
  } catch (e) {
    next(e instanceof HttpError ? e : new HttpError(401, 'Invalid or expired token'));
  }
};

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) return next(new HttpError(403, 'Forbidden'));
    next();
  };

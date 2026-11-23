import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { Role } from '../models';

export interface AuthPayload {
  userId: string;
  role: Role;
}

export const signToken = (payload: AuthPayload) =>
  jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as SignOptions);

export const verifyToken = (token: string) => jwt.verify(token, env.JWT_SECRET) as AuthPayload;

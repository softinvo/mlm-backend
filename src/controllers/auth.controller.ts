import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { Request, Response } from 'express';
import { AuditLog, Franchise, FranchiseTier, Member, User, Wallet } from '../models';
import { issueOtp, verifyOtp } from '../services/otp.service';
import { HttpError } from '../utils/http';
import { signToken } from '../utils/jwt';

const registerSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().email(),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
  password: z.string().min(8),
  sponsorCode: z.string().trim().min(1),   // memberCode of the referrer
  franchiseCode: z.string().trim().min(1), // onboarding franchise
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

const newMemberCode = () => 'M' + randomBytes(5).toString('hex').toUpperCase();

export const register = async (req: Request, res: Response) => {
  const body = registerSchema.parse(req.body);

  const [sponsor, franchise] = await Promise.all([
    Member.findOne({ memberCode: body.sponsorCode }),
    Franchise.findOne({ code: body.franchiseCode, active: true }),
  ]);
  if (!sponsor) throw new HttpError(400, 'Invalid sponsor code');
  if (!franchise) throw new HttpError(400, 'Invalid franchise code');
  // A tier can cap how many members a franchise may onboard.
  const tier = franchise.tierId ? await FranchiseTier.findById(franchise.tierId).lean() : null;
  if (tier && tier.maxMembers > 0 && (await Member.countDocuments({ franchiseId: franchise._id })) >= tier.maxMembers) {
    throw new HttpError(400, 'This franchise is not accepting new members right now');
  }

  const user = await User.create({
    role: 'MEMBER',
    status: 'ACTIVE',
    name: body.name,
    email: body.email,
    phone: body.phone,
    passwordHash: await bcrypt.hash(body.password, 12),
  });

  try {
    await Wallet.create({ userId: user._id, type: 'INCOME' });
    await Member.create({
      userId: user._id,
      memberCode: newMemberCode(),
      sponsorId: sponsor._id,
      upline: [sponsor._id, ...sponsor.upline], // nearest first
      franchiseId: franchise._id,
    });
  } catch (err) {
    // No multi-doc transaction here; roll back the partial signup.
    await Promise.all([User.deleteOne({ _id: user._id }), Wallet.deleteOne({ userId: user._id })]);
    throw err;
  }

  res.status(201).json({ token: signToken({ userId: user.id, role: 'MEMBER' }) });
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  // Same message for unknown email and wrong password.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, 'Invalid email or password');
  }
  if (user.status !== 'ACTIVE') throw new HttpError(403, `Account is ${user.status.toLowerCase()}`);
  res.json({ token: signToken({ userId: user.id, role: user.role }), role: user.role, name: user.name });
};

// ───────── Forgot password (one-time code by SMS or email) ─────────

const identifierSchema = z.string().trim().toLowerCase().min(5).max(120);
const findByIdentifier = (id: string) => User.findOne(/^\d{10}$/.test(id) ? { phone: id } : { email: id });
const SENT = { ok: true, message: 'If an account matches, we have sent a code. It is valid for a few minutes.' };

/** Always answers the same way, so nobody can use this to find out who has an account. */
export const forgotPassword = async (req: Request, res: Response) => {
  const b = z.object({ identifier: identifierSchema, channel: z.enum(['SMS', 'EMAIL']).optional() }).parse(req.body);
  const user = await findByIdentifier(b.identifier);
  if (user && user.status === 'ACTIVE') {
    try { await issueOtp({ userId: user.id, purpose: 'PASSWORD_RESET', channel: b.channel }); }
    catch (e) { console.error('Forgot-password code not sent:', (e as Error).message); }
  }
  res.json(SENT);
};

export const resetPasswordWithOtp = async (req: Request, res: Response) => {
  const b = z.object({
    identifier: identifierSchema, otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
    password: z.string().min(8, 'Use at least 8 characters').max(72).regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number'),
  }).parse(req.body);
  const user = await findByIdentifier(b.identifier);
  if (!user || user.status !== 'ACTIVE') throw new HttpError(400, 'That code is not right. Please check it and try again.');
  await verifyOtp({ userId: user.id, purpose: 'PASSWORD_RESET', code: b.otp });
  await User.updateOne({ _id: user._id }, { $set: { passwordHash: await bcrypt.hash(b.password, 12) } });
  await AuditLog.create({ actorId: user._id, action: 'PASSWORD_RESET_BY_OTP', entity: 'User', entityId: user._id });
  res.json({ ok: true });
};

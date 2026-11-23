import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import { z } from 'zod';
import { AuditLog, Member, User } from '../models';
import { HttpError } from '../utils/http';

const optStr = (max: number) => z.string().trim().max(max).optional();

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
  dateOfBirth: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use the format YYYY-MM-DD')
    .refine((v) => {
      if (!v) return true;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return false;
      const eighteen = new Date(); eighteen.setFullYear(eighteen.getFullYear() - 18);
      return d <= eighteen;
    }, 'You must be at least 18 years old')
    .optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', '']).optional(),
  address: z
    .object({
      line1: optStr(120), line2: optStr(120), city: optStr(60), state: optStr(60),
      pincode: z.string().trim().regex(/^(\d{6})?$/, 'Enter a 6-digit pincode').optional(),
    })
    .optional(),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z
    .string()
    .min(8, 'Use at least 8 characters')
    .max(72, 'Use at most 72 characters')
    .regex(/[A-Za-z]/, 'Include at least one letter')
    .regex(/\d/, 'Include at least one number'),
});

async function loadProfile(userId: string) {
  const [user, member] = await Promise.all([
    User.findById(userId),
    Member.findOne({ userId }).populate('sponsorId', 'memberCode').populate('franchiseId', 'name code'),
  ]);
  if (!user || !member) throw new HttpError(404, 'Member profile not found');
  return { user, member };
}

function serialize(user: Awaited<ReturnType<typeof loadProfile>>['user'], member: Awaited<ReturnType<typeof loadProfile>>['member']) {
  const a = user.address;
  return {
    name: user.name,
    email: user.email,
    phone: user.phone,
    dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : '',
    gender: user.gender ?? '',
    address: { line1: a?.line1 ?? '', line2: a?.line2 ?? '', city: a?.city ?? '', state: a?.state ?? '', pincode: a?.pincode ?? '' },
    memberCode: member.memberCode,
    rank: member.rank,
    joinedAt: member.joinedAt,
    sponsorCode: (member.sponsorId as any)?.memberCode ?? null,
    franchise: member.franchiseId,
    otpChannel: (user.otpChannel as 'SMS' | 'EMAIL') ?? 'SMS',
  };
}

export const getProfile = async (req: Request, res: Response) => {
  const { user, member } = await loadProfile(req.auth!.userId);
  res.json(serialize(user, member));
};

export const updateProfile = async (req: Request, res: Response) => {
  const body = profileSchema.parse(req.body);
  const { user, member } = await loadProfile(req.auth!.userId);
  const before = serialize(user, member);

  user.name = body.name;
  user.phone = body.phone;
  user.set('dateOfBirth', body.dateOfBirth ? new Date(body.dateOfBirth) : undefined);
  user.set('gender', body.gender || undefined);
  if (body.address) {
    const a = body.address;
    user.set('address', {
      line1: a.line1 || undefined, line2: a.line2 || undefined, city: a.city || undefined,
      state: a.state || undefined, pincode: a.pincode || undefined,
    });
  }

  try {
    await user.save();
  } catch (err: any) {
    if (err?.code === 11000) throw new HttpError(409, 'This mobile number is already registered');
    throw err;
  }

  const after = serialize(user, member);
  await AuditLog.create({ actorId: user._id, action: 'PROFILE_UPDATE', entity: 'User', entityId: user._id, before, after });
  res.json(after);
};

export const changePassword = async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = passwordSchema.parse(req.body);
  const user = await User.findById(req.auth!.userId).select('+passwordHash');
  if (!user) throw new HttpError(404, 'User not found');

  // 400 (not 401): the frontend treats 401 as "session expired".
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  if (currentPassword === newPassword) throw new HttpError(400, 'New password must be different from the current one');

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  await user.save();
  await AuditLog.create({ actorId: user._id, action: 'PASSWORD_CHANGE', entity: 'User', entityId: user._id });
  res.json({ ok: true });
};

/** Where the member wants their one-time codes (shop payments use this; withdrawals and password reset let them pick each time). */
export const setOtpChannel = async (req: Request, res: Response) => {
  const { channel } = z.object({ channel: z.enum(['SMS', 'EMAIL']) }).parse(req.body);
  await User.updateOne({ _id: req.auth!.userId }, { $set: { otpChannel: channel } });
  res.json({ otpChannel: channel });
};

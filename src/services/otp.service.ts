/**
 * One-time codes: 6 digits, stored as a salted hash, valid for a few minutes, limited tries and limited re-sends.
 * A code only works for the purpose and reference it was issued for (e.g. one specific payment request).
 */
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { Otp, OtpPurpose, User } from '../models';
import { HttpError } from '../utils/http';
import { Channel, devFixedCode, sendCode } from './notify.service';

const ttl = (purpose?: string) => (purpose === 'WALLET_SALE' ? Number(process.env.PAYMENT_REQUEST_MINUTES ?? 5) : Number(process.env.OTP_TTL_MINUTES ?? 10));
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 4;          // per person, per purpose, per window
const SEND_WINDOW_MIN = 15;
const COOLDOWN_SEC = 30;      // between two sends

const hash = (userId: string, purpose: string, ref: string, code: string) =>
  createHash('sha256').update(`${process.env.JWT_SECRET ?? ''}|${userId}|${purpose}|${ref}|${code}`).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const WHAT: Record<OtpPurpose, string> = { PASSWORD_RESET: 'reset your password', WITHDRAWAL: 'confirm your withdrawal', WALLET_SALE: 'approve a payment from your shopping wallet' };

/** Creates a fresh code (older unused ones stop working) and sends it. Returns where it went, masked. */
export async function issueOtp(i: { userId: string; purpose: OtpPurpose; ref?: string; channel?: Channel; now?: Date }) {
  const now = i.now ?? new Date();
  const user = await User.findById(i.userId).select('name email phone otpChannel');
  if (!user) throw new HttpError(404, 'User not found');
  const ref = i.ref ?? '';
  const channel: Channel = i.channel ?? (user.otpChannel as Channel) ?? 'SMS';

  const last = await Otp.findOne({ userId: user._id, purpose: i.purpose, ref }).sort({ createdAt: -1 }).select('createdAt');
  if (last && now.getTime() - last.createdAt.getTime() < COOLDOWN_SEC * 1000) throw new HttpError(429, `Please wait ${COOLDOWN_SEC} seconds before asking for another code.`);
  const since = new Date(now.getTime() - SEND_WINDOW_MIN * 60_000);
  // one code can be re-sent a few times; a shopper can also pay at several shops in a row, so wallet sales get a wider overall cap
  const [forThis, forPurpose] = await Promise.all([
    Otp.countDocuments({ userId: user._id, purpose: i.purpose, ref, createdAt: { $gte: since } }),
    Otp.countDocuments({ userId: user._id, purpose: i.purpose, createdAt: { $gte: since } }),
  ]);
  if (forThis >= MAX_SENDS || forPurpose >= (i.purpose === 'WALLET_SALE' ? 20 : MAX_SENDS)) throw new HttpError(429, 'Too many codes requested. Please try again in a few minutes.');

  const fixed = devFixedCode();
  const code = fixed ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
  await Otp.updateMany({ userId: user._id, purpose: i.purpose, ref, usedAt: { $exists: false } }, { $set: { usedAt: now } });
  const row = await Otp.create({ userId: user._id, purpose: i.purpose, ref, channel, codeHash: hash(user._id.toString(), i.purpose, ref, code), expiresAt: new Date(now.getTime() + ttl(i.purpose) * 60_000) });
  try {
    if (fixed) console.log(`[dev] ${channel} code for ${channel === 'SMS' ? user.phone : user.email} is ${fixed} (NODE_ENV=development, nothing sent)`);
    else await sendCode(channel, { name: user.name, email: user.email, phone: user.phone }, code, WHAT[i.purpose], ttl(i.purpose));
  } catch (e) {
    await Otp.deleteOne({ _id: row._id }); // nothing was delivered, so don't count it
    throw e;
  }
  return { channel, sentTo: channel === 'SMS' ? `XXXXXX${user.phone.slice(-4)}` : maskEmail(user.email), expiresInMinutes: ttl(i.purpose) };
}

export const maskEmail = (e: string) => { const [n, d] = e.split('@'); return `${n.slice(0, 2)}${'•'.repeat(Math.max(1, n.length - 2))}@${d}`; };

/** Checks a code. A right code is consumed (works once); a wrong one counts against the limit. */
export async function verifyOtp(i: { userId: string; purpose: OtpPurpose; ref?: string; code: string; now?: Date }) {
  const now = i.now ?? new Date();
  const ref = i.ref ?? '';
  const row = await Otp.findOne({ userId: i.userId, purpose: i.purpose, ref, usedAt: { $exists: false } }).sort({ createdAt: -1 });
  if (!row || row.expiresAt <= now) throw new HttpError(400, 'This code has expired. Please ask for a new one.');
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong tries. Please ask for a new code.');
  if (!/^\d{6}$/.test(i.code) || !same(row.codeHash, hash(String(i.userId), i.purpose, ref, i.code))) {
    await Otp.updateOne({ _id: row._id }, { $inc: { attempts: 1 } });
    throw new HttpError(400, 'That code is not right. Please check it and try again.');
  }
  const used = await Otp.findOneAndUpdate({ _id: row._id, usedAt: { $exists: false } }, { $set: { usedAt: now } });
  if (!used) throw new HttpError(409, 'This code was just used. Please ask for a new one.');
}

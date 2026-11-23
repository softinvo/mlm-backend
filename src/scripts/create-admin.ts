// Creates a head-office (SUPER_ADMIN) login. There is deliberately no API for this: only people with
// server access can add one, and the total is capped (ADMIN_MAX, default 2).
//   npm run create-admin -- --email you@company.com --name "Your Name" --phone 9876543210 [--password ...]
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { User, Wallet } from '../models';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : undefined; };

async function main() {
  const email = arg('email')?.toLowerCase(), name = arg('name'), phone = arg('phone');
  if (!email || !name || !phone) throw new Error('Usage: npm run create-admin -- --email <email> --name "<name>" --phone <10-digit> [--password <pw>]');
  if (!/^[6-9]\d{9}$/.test(phone)) throw new Error('Phone must be a 10-digit Indian mobile number');
  const max = Number(process.env.ADMIN_MAX ?? 2);

  await mongoose.connect(env.MONGODB_URI);
  const count = await User.countDocuments({ role: 'SUPER_ADMIN' });
  if (count >= max) throw new Error(`There are already ${count} admin accounts (limit ${max}). Remove one or raise ADMIN_MAX on purpose.`);
  if (await User.exists({ $or: [{ email }, { phone }] })) throw new Error('That email or phone is already registered');

  const password = arg('password') ?? randomBytes(9).toString('base64url');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  const u = await User.create({ role: 'SUPER_ADMIN', status: 'ACTIVE', name, email, phone, passwordHash: await bcrypt.hash(password, 12) });
  await Wallet.create({ userId: u._id, type: 'INCOME' });
  console.log(`Admin created: ${email}`);
  if (!arg('password')) console.log(`Temporary password (shown once, change it after signing in): ${password}`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e.message); process.exit(1); });

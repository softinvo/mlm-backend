import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// Dev fallback derives a key from JWT_SECRET; production requires KYC_ENC_KEY (enforced in config/env.ts).
const key = () => {
  const hex = process.env.KYC_ENC_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  return createHash('sha256').update('kyc-key:' + (process.env.JWT_SECRET ?? 'dev-only')).digest();
};

/** AES-256-GCM. Output: iv:tag:ciphertext (hex). */
export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

export function decrypt(payload: string) {
  const [iv, tag, enc] = payload.split(':').map((h) => Buffer.from(h, 'hex'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export const hashPan = (pan: string) => createHash('sha256').update('pan:' + key().toString('hex') + pan).digest('hex');

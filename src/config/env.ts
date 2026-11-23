import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  COOLING_OFF_DAYS: z.coerce.number().int().min(0).default(7),   // commission is held this long after delivery
  COMMISSION_JOB_MINUTES: z.coerce.number().int().min(0).default(15), // 0 disables the in-process approval job
  WITHDRAWAL_MIN_PAISE: z.coerce.number().int().min(100).default(10_000),     // minimum withdrawal (₹100)
  WITHDRAWAL_FEE_PERCENT: z.coerce.number().min(0).max(50).default(15),         // admin charge deducted from each withdrawal (15% in the plan)
  WITHDRAWAL_TDS_PERCENT: z.coerce.number().min(0).max(50).default(0),          // tax deducted at source, set with your accountant
  P2P_DAILY_LIMIT_PAISE: z.coerce.number().int().min(0).default(1_000_000),       // max a member can send per rolling 24h (₹10,000)
  KYC_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters').optional(), // encrypts bank account numbers
  // Image uploads (Cloudflare R2 / any S3-compatible bucket). Leave blank to turn uploads off.
  R2_S3_API_URL: z.string().url().optional().or(z.literal('')),     // the bucket's S3 API endpoint
  R2_API_KEY_ID: z.string().optional(),
  R2_API_ACCESS_TOKEN: z.string().optional(),
  BUCKET_NAME: z.string().optional(),
  STORAGE_URL: z.string().url().optional().or(z.literal('')),       // public base URL files are served from
  CORS_ORIGIN: z.string().default('http://localhost:5173,http://localhost:5174'), // comma-separated: member app, franchise portal, ...
});

export const env = schema.parse(process.env);
if (process.env.NODE_ENV === 'production' && !env.KYC_ENC_KEY) throw new Error('KYC_ENC_KEY is required in production');

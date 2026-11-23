import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { AuditLog, WalletEntryTypes, WithdrawalStatuses } from '../models';
import {
  cancelWithdrawal, getWalletSummary, listEntries, listMemberWithdrawals, quoteWithdrawal, requestWithdrawal, submitKyc, transferToShopping,
} from '../services/wallet.service';
import { HttpError } from '../utils/http';
import { issueOtp, verifyOtp } from '../services/otp.service';

const page = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(10) };
const amount = z.number().int('Enter a whole number of paise').min(1);

export const walletSummary = async (req: Request, res: Response) => res.json(await getWalletSummary(req.auth!.userId));

const kycSchema = z.object({
  accountHolder: z.string().trim().min(2, 'Enter the name on the bank account').max(80),
  accountNumber: z.string().regex(/^\d{9,18}$/, 'Account number must be 9 to 18 digits'),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code'),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Enter a valid PAN'),
});

export const saveKyc = async (req: Request, res: Response) => {
  await submitKyc(req.auth!.userId, kycSchema.parse(req.body));
  await AuditLog.create({ actorId: req.auth!.userId, action: 'KYC_SUBMITTED', entity: 'User', entityId: req.auth!.userId });
  res.json(await getWalletSummary(req.auth!.userId));
};

export const quote = async (req: Request, res: Response) => {
  res.json(quoteWithdrawal(z.object({ amountPaise: amount }).parse(req.body).amountPaise));
};

const channel = z.enum(['SMS', 'EMAIL']).optional();

/** Step 1 of a withdrawal: send the member a code. */
export const sendWithdrawalOtp = async (req: Request, res: Response) => {
  const { channel: ch } = z.object({ channel }).parse(req.body ?? {});
  res.json(await issueOtp({ userId: req.auth!.userId, purpose: 'WITHDRAWAL', channel: ch }));
};

/** Step 2: the withdrawal only goes through with the right code. */
export const createWithdrawal = async (req: Request, res: Response) => {
  const { amountPaise, otp } = z.object({ amountPaise: amount, otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code we sent you') }).parse(req.body);
  await verifyOtp({ userId: req.auth!.userId, purpose: 'WITHDRAWAL', code: otp });
  const w = await requestWithdrawal(req.auth!.userId, amountPaise);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'WITHDRAWAL_REQUESTED', entity: 'Withdrawal', entityId: w._id, after: { amountPaise } });
  res.status(201).json({ id: w._id.toString(), status: w.status, amountPaise: w.amountPaise, netPaise: w.netPaise });
};

export const myWithdrawals = async (req: Request, res: Response) => {
  const q = z.object({ ...page, status: z.enum(WithdrawalStatuses).optional() }).parse(req.query);
  res.json(await listMemberWithdrawals(req.auth!.userId, q));
};

export const cancelMyWithdrawal = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!isValidObjectId(id)) throw new HttpError(404, 'Withdrawal not found');
  const w = await cancelWithdrawal(req.auth!.userId, id);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'WITHDRAWAL_CANCELLED', entity: 'Withdrawal', entityId: w._id });
  res.json({ id: w._id.toString(), status: w.status });
};

export const transfer = async (req: Request, res: Response) => {
  const { amountPaise } = z.object({ amountPaise: amount }).parse(req.body);
  const r = await transferToShopping(req.auth!.userId, amountPaise);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'WALLET_TRANSFER', entity: 'Wallet', entityId: req.auth!.userId, after: { amountPaise } });
  res.json(r);
};

/** Passbook (income wallet) and shopping wallet history share this endpoint. */
export const walletEntries = async (req: Request, res: Response) => {
  const q = z.object({ ...page, wallet: z.enum(['income', 'shopping']).default('income'), type: z.enum(WalletEntryTypes).optional() }).parse(req.query);
  res.json(await listEntries(req.auth!.userId, q.wallet === 'income' ? 'INCOME' : 'SHOPPING', { entryType: q.type, page: q.page, limit: q.limit }));
};

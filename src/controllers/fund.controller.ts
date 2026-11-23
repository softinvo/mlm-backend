import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { AuditLog, FundRequestStatuses, PaymentModes } from '../models';
import {
  approveFundRequest, cancelFundRequest, fundConfig, listMemberFundRequests, paymentInstructions, rejectFundRequest, submitFundRequest,
} from '../services/fund.service';
import { listFunds } from '../services/franchise.service';
import { getWalletSummary } from '../services/wallet.service';
import { HttpError } from '../utils/http';

const id = (req: Request) => {
  const v = req.params.id as string;
  if (!isValidObjectId(v)) throw new HttpError(404, 'Request not found');
  return v;
};
const paging = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(10) };

/** Where to pay, the limits, and the member's shopping balance. */
export const fundInfo = async (req: Request, res: Response) => {
  const w = await getWalletSummary(req.auth!.userId);
  res.json({ instructions: paymentInstructions(), limits: fundConfig(), shoppingBalancePaise: w.shoppingBalancePaise, modes: PaymentModes });
};

const submitSchema = z.object({
  amountPaise: z.number().int('Enter a whole number of paise').min(1),
  mode: z.enum(PaymentModes),
  reference: z.string().trim().regex(/^[A-Za-z0-9\-\/]{6,30}$/, 'Enter the bank reference / UTR (6 to 30 letters or digits)'),
  paidOn: z.coerce.date({ message: 'Enter the payment date' }),
  note: z.string().trim().max(200).optional(),
});

export const submit = async (req: Request, res: Response) => {
  const body = submitSchema.parse(req.body);
  const r = await submitFundRequest(req.auth!.userId, body);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'FUND_REQUEST_SUBMITTED', entity: 'FundRequest', entityId: r._id, after: { amountPaise: body.amountPaise, mode: body.mode } });
  res.status(201).json({ id: r._id.toString(), status: r.status });
};

export const mine = async (req: Request, res: Response) => {
  const q = z.object({ ...paging, status: z.enum(FundRequestStatuses).optional() }).parse(req.query);
  res.json(await listMemberFundRequests(req.auth!.userId, q));
};

export const cancelMine = async (req: Request, res: Response) => {
  const r = await cancelFundRequest(req.auth!.userId, id(req));
  await AuditLog.create({ actorId: req.auth!.userId, action: 'FUND_REQUEST_CANCELLED', entity: 'FundRequest', entityId: r._id });
  res.json({ id: r._id.toString(), status: r.status });
};

// ───────── head office ─────────

export const adminList = async (req: Request, res: Response) => {
  const q = z.object({ ...paging, limit: z.coerce.number().int().min(1).max(100).default(20), status: z.enum(FundRequestStatuses).optional() }).parse(req.query);
  res.json(await listFunds(null, { ...q, recommended: undefined }));
};

export const adminApprove = async (req: Request, res: Response) => {
  const body = z.object({ approvedPaise: z.number().int().min(1).optional(), note: z.string().trim().max(200).optional() }).parse(req.body);
  const r = await approveFundRequest(id(req), req.auth!.userId, body);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'FUND_REQUEST_APPROVED', entity: 'FundRequest', entityId: r._id, after: { approvedPaise: r.approvedPaise } });
  res.json({ id: r._id.toString(), status: r.status, approvedPaise: r.approvedPaise });
};

export const adminReject = async (req: Request, res: Response) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
  const r = await rejectFundRequest(id(req), req.auth!.userId, reason);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'FUND_REQUEST_REJECTED', entity: 'FundRequest', entityId: r._id, after: { reason } });
  res.json({ id: r._id.toString(), status: r.status });
};

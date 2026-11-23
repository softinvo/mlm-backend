import { Request, Response } from 'express';
import { z } from 'zod';
import { AuditLog, CashbackSettings } from '../models';
import { cashbackDays, getCashbackSettings, memberCashback, payDueCashback, saveCashbackSettings } from '../services/cashback.service';
import { HttpError } from '../utils/http';

export const myCashback = async (req: Request, res: Response) => res.json(await memberCashback(req.auth!.userId));

const withDays = async () => { const c = await getCashbackSettings(); return { ...c, days: cashbackDays(c) }; };
export const getCashback = async (_req: Request, res: Response) => res.json(await withDays());

const schema = z.object({
  enabled: z.boolean(),
  percentPerDay: z.number().min(0.01, 'Enter a daily rate above 0').max(100),
  maxDays: z.number().int().min(1).max(365),
  maxTotalPercent: z.number().min(0.01).max(100),
  includePackages: z.boolean(),
});

export const putCashback = async (req: Request, res: Response) => {
  const b = schema.parse(req.body);
  if (b.percentPerDay > b.maxTotalPercent) throw new HttpError(400, 'The daily rate cannot be higher than the total cashback limit');
  const before = await getCashbackSettings();
  await saveCashbackSettings(b);
  const doc = await CashbackSettings.findOne({ key: 'cashback' }).select('_id').lean();
  await AuditLog.create({ actorId: req.auth!.userId, action: 'CASHBACK_SETTINGS_UPDATED', entity: 'CashbackSettings', entityId: doc!._id, before, after: b });
  res.json(await withDays());
};

export const runCashbackJob = async (_req: Request, res: Response) => res.json(await payDueCashback());

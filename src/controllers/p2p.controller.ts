import { Request, Response } from 'express';
import { z } from 'zod';
import { AuditLog } from '../models';
import { listP2P, lookupRecipient, sendP2P } from '../services/p2p.service';

export const lookup = async (req: Request, res: Response) => {
  const { code } = z.object({ code: z.string().trim().min(3).max(20) }).parse(req.query);
  res.json(await lookupRecipient(req.auth!.userId, code));
};

export const send = async (req: Request, res: Response) => {
  const body = z.object({
    toMemberCode: z.string().trim().min(3).max(20),
    amountPaise: z.number().int('Enter a whole number of paise').min(1),
    note: z.string().trim().max(80).optional(),
    clientKey: z.string().min(8).max(64).optional(),
  }).parse(req.body);
  const t = await sendP2P(req.auth!.userId, body);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'P2P_TRANSFER', entity: 'P2PTransfer', entityId: t.id, after: { to: body.toMemberCode, amountPaise: body.amountPaise } });
  res.status(201).json(t);
};

export const history = async (req: Request, res: Response) => {
  const q = z.object({
    direction: z.enum(['all', 'sent', 'received']).default('all'),
    page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(10),
  }).parse(req.query);
  res.json(await listP2P(req.auth!.userId, q));
};

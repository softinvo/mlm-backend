import { Request, Response } from 'express';
import { z } from 'zod';
import { AuditLog, RankCriteria, Ranks } from '../models';
import { getMemberId } from '../services/team.service';
import { getRankCriteria, purchaseStatus, rewardsStatus, saveRankCriteria } from '../services/teamstatus.service';

export const myPurchaseStatus = async (req: Request, res: Response) => res.json(await purchaseStatus(await getMemberId(req.auth!.userId)));
export const myRewards = async (req: Request, res: Response) => res.json(await rewardsStatus(await getMemberId(req.auth!.userId)));

export const getCriteria = async (_req: Request, res: Response) => res.json(await getRankCriteria());

const schema = z.object({
  ranks: z.array(z.object({ rank: z.enum(Ranks), minTeamVolumePaise: z.number().int().min(0), minActiveDirects: z.number().int().min(0).max(100000) })).max(Ranks.length),
});
export const putCriteria = async (req: Request, res: Response) => {
  const b = schema.parse(req.body);
  const before = await getRankCriteria();
  const saved = await saveRankCriteria(b.ranks.filter((r) => r.rank !== 'ASSOCIATE'));
  const doc = await RankCriteria.findOne({ key: 'ranks' }).select('_id').lean();
  await AuditLog.create({ actorId: req.auth!.userId, action: 'RANK_CRITERIA_UPDATED', entity: 'RankCriteria', entityId: doc!._id, before, after: saved });
  res.json(saved);
};

import { Request, Response } from 'express';
import { z } from 'zod';
import { Commission, Member, Order, User } from '../models';
import { getMemberId } from '../services/team.service';

const query = z.object({
  type: z.enum(['all', 'direct', 'level', 'repurchase']).default('all'), // direct = level 1, level = level 2+ (both joining packages); repurchase = the repurchase royalty
  status: z.enum(['PENDING', 'APPROVED', 'REVERSED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

const effective = { $subtract: ['$amountPaise', { $ifNull: ['$reversedPaise', 0] }] };

/** The member's commission earnings, filterable by type (direct sponsor vs level income) and status. */
export const myCommissions = async (req: Request, res: Response) => {
  const q = query.parse(req.query);
  const earnerId = await getMemberId(req.auth!.userId);
  const base: Record<string, unknown> = { earnerId };
  if (q.type === 'repurchase') base.kind = 'REPURCHASE';
  else if (q.type !== 'all') base.kind = { $ne: 'REPURCHASE' }; // older rows have no kind: they are joining/level income
  if (q.type === 'direct') base.level = 1;
  if (q.type === 'level') base.level = { $gte: 2 };
  const match = { ...base, ...(q.status ? { status: q.status } : {}) };

  const [list, totals] = await Promise.all([
    Commission.aggregate([
      { $match: match },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          items: [
            { $skip: (q.page - 1) * q.limit }, { $limit: q.limit },
            { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'o', pipeline: [{ $project: { buyerId: 1, coolingOffEndsAt: 1 } }] } },
            { $unwind: '$o' },
            { $lookup: { from: User.collection.name, localField: 'o.buyerId', foreignField: '_id', as: 'u', pipeline: [{ $project: { name: 1 } }] } },
            { $lookup: { from: Member.collection.name, localField: 'o.buyerId', foreignField: 'userId', as: 'm', pipeline: [{ $project: { memberCode: 1 } }] } },
            {
              $project: {
                _id: 0, id: { $toString: '$_id' }, orderNo: { $concat: ['#', { $toUpper: { $substrBytes: [{ $toString: '$orderId' }, 18, 6] } }] },
                level: 1, status: 1, createdAt: 1, originalPaise: '$amountPaise', reversedPaise: { $ifNull: ['$reversedPaise', 0] },
                amountPaise: effective, releaseAt: { $cond: [{ $eq: ['$status', 'PENDING'] }, '$o.coolingOffEndsAt', null] },
                fromName: { $arrayElemAt: ['$u.name', 0] }, fromCode: { $arrayElemAt: ['$m.memberCode', 0] },
              },
            },
          ],
          total: [{ $count: 'n' }],
        },
      },
    ]),
    // Totals ignore the status filter so the summary cards always show the full picture for this type.
    Commission.aggregate([
      { $match: base },
      { $group: { _id: '$status', total: { $sum: effective }, reversed: { $sum: { $ifNull: ['$reversedPaise', 0] } } } },
    ]),
  ]);

  const total: number = list[0]?.total[0]?.n ?? 0;
  const sum = (s: string) => totals.find((t) => t._id === s)?.total ?? 0;
  res.json({
    items: list[0]?.items ?? [], total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
    summary: {
      approvedPaise: sum('APPROVED'), pendingPaise: sum('PENDING'),
      reversedPaise: totals.reduce((n, t) => n + t.reversed, 0),
    },
  });
};

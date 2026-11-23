/**
 * Two read-only views for the member portal:
 *  - Global Purchase Status: how much the member's whole team is buying.
 *  - Rewards & Awards Status: the member's rank, the head office's requirements for the next ranks and the progress towards them.
 * Nothing here pays anything or changes a rank: ranks stay with the head office.
 */
import { Types } from 'mongoose';
import { Member, Order, Ranks, RankCriteria, User, type Rank } from '../models';
import { ACTIVE_WINDOW_DAYS } from './team.service';

const DAY = 86_400_000;
const COUNTED = ['PAID', 'DELIVERED', 'PARTIALLY_REFUNDED'];
const MIN_LEVELS = 10;

/** Every member below `memberId` with their level, and what each of them has bought. */
async function teamBuying(memberId: Types.ObjectId) {
  const team = await Member.aggregate<{ _id: Types.ObjectId; userId: Types.ObjectId; memberCode: string; level: number }>([
    { $match: { upline: memberId } },
    { $project: { userId: 1, memberCode: 1, level: { $add: [{ $indexOfArray: ['$upline', memberId] }, 1] } } },
  ]);
  const userIds = team.map((t) => t.userId);
  const since = new Date(Date.now() - ACTIVE_WINDOW_DAYS * DAY);
  const orders = userIds.length
    ? await Order.aggregate<{ _id: Types.ObjectId; orders: number; valuePaise: number; recentOrders: number; recentValuePaise: number; deliveredPaise: number }>([
        { $match: { buyerId: { $in: userIds }, status: { $in: COUNTED } } },
        { $addFields: { net: { $subtract: ['$totalPaise', { $ifNull: ['$refundedPaise', 0] }] }, recent: { $gte: ['$createdAt', since] } } },
        { $group: {
          _id: '$buyerId', orders: { $sum: 1 }, valuePaise: { $sum: '$net' },
          recentOrders: { $sum: { $cond: ['$recent', 1, 0] } }, recentValuePaise: { $sum: { $cond: ['$recent', '$net', 0] } },
          deliveredPaise: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, '$net', 0] } },
        } },
      ])
    : [];
  const byUser = new Map(orders.map((o) => [o._id.toString(), o]));
  return { team, byUser, userIds, since };
}

export async function purchaseStatus(memberId: Types.ObjectId) {
  const { team, byUser, userIds } = await teamBuying(memberId);
  const maxLevel = Math.max(MIN_LEVELS, ...team.map((t) => t.level));
  const levels = Array.from({ length: maxLevel }, (_, i) => ({ level: i + 1, members: 0, buyers: 0, active: 0, orders: 0, valuePaise: 0 }));
  const totals = { teamSize: team.length, buyers: 0, active: 0, orders: 0, valuePaise: 0, recentOrders: 0, recentValuePaise: 0 };
  for (const t of team) {
    const o = byUser.get(t.userId.toString());
    const row = levels[t.level - 1];
    row.members++;
    if (o) { row.buyers++; row.orders += o.orders; row.valuePaise += o.valuePaise; totals.buyers++; totals.orders += o.orders; totals.valuePaise += o.valuePaise; totals.recentOrders += o.recentOrders; totals.recentValuePaise += o.recentValuePaise; }
    if (o && o.recentOrders > 0) { row.active++; totals.active++; }
  }

  const recent = userIds.length ? await Order.find({ buyerId: { $in: userIds }, status: { $in: COUNTED } }).sort({ createdAt: -1 }).limit(10).select('buyerId totalPaise refundedPaise status items createdAt').lean() : [];
  const people = await User.find({ _id: { $in: recent.map((r) => r.buyerId) } }).select('name').lean();
  const info = new Map(team.map((t) => [t.userId.toString(), t]));
  return {
    windowDays: ACTIVE_WINDOW_DAYS,
    totals,
    levels,
    recent: recent.map((r) => ({
      id: r._id.toString(), at: r.createdAt, status: r.status, valuePaise: r.totalPaise - (r.refundedPaise ?? 0),
      kind: r.items.some((i) => i.packageId) ? 'Joining package' : 'Repurchase',
      buyerName: people.find((p) => p._id.equals(r.buyerId))?.name ?? '—', buyerCode: info.get(r.buyerId.toString())?.memberCode ?? '', level: info.get(r.buyerId.toString())?.level ?? 0,
    })),
  };
}

export interface RankRequirement { rank: Rank; minTeamVolumePaise: number; minActiveDirects: number }

export async function getRankCriteria(): Promise<RankRequirement[]> {
  const d = await RankCriteria.findOne({ key: 'ranks' }).lean();
  return (d?.ranks ?? []).map((r) => ({ rank: r.rank as Rank, minTeamVolumePaise: r.minTeamVolumePaise ?? 0, minActiveDirects: r.minActiveDirects ?? 0 }));
}

export async function saveRankCriteria(list: RankRequirement[]) {
  await RankCriteria.findOneAndUpdate({ key: 'ranks' }, { $set: { ranks: list } }, { upsert: true, new: true });
  return getRankCriteria();
}

export async function rewardsStatus(memberId: Types.ObjectId) {
  const [me, criteria, { team, byUser }] = await Promise.all([Member.findById(memberId).select('rank').lean(), getRankCriteria(), teamBuying(memberId)]);
  const rank = (me?.rank ?? 'ASSOCIATE') as Rank;
  const teamVolumePaise = team.reduce((n, t) => n + (byUser.get(t.userId.toString())?.deliveredPaise ?? 0), 0);
  const directs = team.filter((t) => t.level === 1);
  const activeDirects = directs.filter((t) => (byUser.get(t.userId.toString())?.recentOrders ?? 0) > 0).length;
  const pct = (have: number, need: number) => (need <= 0 ? 100 : Math.min(100, Math.floor((have / need) * 100)));

  const ladder = Ranks.map((r) => {
    const req = criteria.find((c) => c.rank === r) ?? null;
    const idx = Ranks.indexOf(r);
    return {
      rank: r, current: r === rank, held: idx <= Ranks.indexOf(rank), requirement: req && idx > 0 ? { minTeamVolumePaise: req.minTeamVolumePaise, minActiveDirects: req.minActiveDirects } : null,
      progress: req && idx > 0 ? { volumePct: pct(teamVolumePaise, req.minTeamVolumePaise), directsPct: pct(activeDirects, req.minActiveDirects), met: teamVolumePaise >= req.minTeamVolumePaise && activeDirects >= req.minActiveDirects } : null,
    };
  });
  const next = Ranks[Ranks.indexOf(rank) + 1] ?? null;
  return {
    rank, next, configured: criteria.some((c) => c.rank !== 'ASSOCIATE'), ladder,
    stats: { teamVolumePaise, directs: directs.length, activeDirects, windowDays: ACTIVE_WINDOW_DAYS },
  };
}

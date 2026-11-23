import { Types } from 'mongoose';
import { Commission, Member, Order, User, Wallet, Withdrawal } from '../models';
import { HttpError } from '../utils/http';

const MAX_LEVELS = 10;

export async function getMemberDashboard(userId: string) {
  const uid = new Types.ObjectId(userId);
  const [user, member, wallet] = await Promise.all([
    User.findById(uid),
    Member.findOne({ userId: uid }).populate('sponsorId', 'memberCode').populate('franchiseId', 'name code'),
    Wallet.findOne({ userId: uid, type: 'INCOME' }),
  ]);
  if (!user || !member || !wallet) throw new HttpError(404, 'Member profile not found');

  const memberId = member._id;
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5, 1);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const [commissionTotals, byLevel, byMonth, teamByLevel, recentCommissions, recentOrders, withdrawn] =
    await Promise.all([
      // totals per status
      Commission.aggregate([
        { $match: { earnerId: memberId } },
        { $group: { _id: '$status', total: { $sum: { $subtract: ['$amountPaise', { $ifNull: ['$reversedPaise', 0] }] } }, count: { $sum: 1 } } },
      ]),
      // approved earnings per level
      Commission.aggregate([
        { $match: { earnerId: memberId, status: 'APPROVED' } },
        { $group: { _id: '$level', total: { $sum: { $subtract: ['$amountPaise', { $ifNull: ['$reversedPaise', 0] }] } } } },
        { $sort: { _id: 1 } },
      ]),
      // approved earnings per month, last 6 months
      Commission.aggregate([
        { $match: { earnerId: memberId, status: 'APPROVED', approvedAt: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$approvedAt' } },
            total: { $sum: { $subtract: ['$amountPaise', { $ifNull: ['$reversedPaise', 0] }] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      // downline size per level: depth = position of me in their upline + 1
      Member.aggregate([
        { $match: { upline: memberId } },
        { $project: { depth: { $add: [{ $indexOfArray: ['$upline', memberId] }, 1] } } },
        { $group: { _id: '$depth', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Commission.find({ earnerId: memberId }).sort({ createdAt: -1 }).limit(10)
        .select('orderId level amountPaise status createdAt'),
      Order.find({ buyerId: uid }).sort({ createdAt: -1 }).limit(5)
        .select('status totalPaise createdAt deliveredAt'),
      Withdrawal.aggregate([
        { $match: { walletId: wallet._id, status: 'PAID' } },
        { $group: { _id: null, total: { $sum: { $subtract: ['$amountPaise', { $ifNull: ['$reversedPaise', 0] }] } } } },
      ]),
    ]);

  const sumFor = (status: string) => commissionTotals.find((c) => c._id === status)?.total ?? 0;

  const levels = Array.from({ length: MAX_LEVELS }, (_, i) => {
    const level = i + 1;
    return {
      level,
      members: teamByLevel.find((t) => t._id === level)?.count ?? 0,
      earnedPaise: byLevel.find((t) => t._id === level)?.total ?? 0,
    };
  });

  return {
    profile: {
      name: user.name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      kycStatus: user.kyc?.status ?? 'NOT_SUBMITTED',
      memberCode: member.memberCode,
      rank: member.rank,
      joinedAt: member.joinedAt,
      sponsorCode: (member.sponsorId as any)?.memberCode ?? null,
      franchise: member.franchiseId,
    },
    wallet: {
      balancePaise: wallet.balancePaise,
      pendingCommissionPaise: sumFor('PENDING'),
      totalEarnedPaise: sumFor('APPROVED'),
      totalWithdrawnPaise: withdrawn[0]?.total ?? 0,
    },
    team: {
      directs: levels[0].members,
      totalDownline: levels.reduce((n, l) => n + l.members, 0),
      levels,
    },
    earningsByMonth: byMonth.map((m) => ({ month: m._id, totalPaise: m.total })),
    recentCommissions,
    recentOrders,
  };
}

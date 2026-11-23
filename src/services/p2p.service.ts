import { Types } from 'mongoose';
import { Member, P2PTransfer, User } from '../models';
import { HttpError } from '../utils/http';
import { withTx } from '../utils/tx';
import { postEntry } from './ledger.service';

export const p2pConfig = () => ({ dailyLimitPaise: Number(process.env.P2P_DAILY_LIMIT_PAISE ?? 1_000_000), minPaise: 100 });

/** "Asha Verma" -> "Asha V." so a member ID lookup never reveals a full name. */
export const maskName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};

async function findRecipient(senderUserId: string, code: string) {
  const member = await Member.findOne({ memberCode: code.trim().toUpperCase() });
  const user = member && (await User.findById(member.userId).select('name status'));
  if (!member || !user || user.status !== 'ACTIVE') throw new HttpError(404, 'No active member found with that ID');
  if (user._id.toString() === senderUserId) throw new HttpError(400, 'You can’t send to yourself');
  return { member, user };
}

export async function lookupRecipient(senderUserId: string, code: string) {
  const { member, user } = await findRecipient(senderUserId, code);
  return { memberCode: member.memberCode, name: maskName(user.name) };
}

const serialize = (t: any, me: string, names: Map<string, string>) => {
  const sent = t.fromUserId.toString() === me;
  const other = (sent ? t.toUserId : t.fromUserId).toString();
  return { id: t._id.toString(), direction: sent ? 'SENT' : 'RECEIVED', amountPaise: t.amountPaise, note: t.note ?? null, counterparty: names.get(other) ?? 'Member', createdAt: t.createdAt };
};

export async function sendP2P(senderId: string, input: { toMemberCode: string; amountPaise: number; note?: string; clientKey?: string }) {
  const cfg = p2pConfig();
  if (!Number.isInteger(input.amountPaise) || input.amountPaise < cfg.minPaise) throw new HttpError(400, `Minimum transfer is ₹${cfg.minPaise / 100}`);
  if (input.amountPaise > cfg.dailyLimitPaise) throw new HttpError(400, `The daily transfer limit is ₹${cfg.dailyLimitPaise / 100}`);

  const retry = async () => {
    const t = input.clientKey && (await P2PTransfer.findOne({ fromUserId: senderId, clientKey: input.clientKey }).lean());
    return t ? serialize(t, senderId, new Map()) : null;
  };
  const existing = await retry();
  if (existing) return existing;

  const [{ member, user }, sender] = await Promise.all([findRecipient(senderId, input.toMemberCode), User.findById(senderId).select('name status')]);
  if (!sender || sender.status !== 'ACTIVE') throw new HttpError(403, 'Your account cannot send transfers right now');

  try {
    return await withTx(async (session) => {
      const tid = new Types.ObjectId();
      // Debit first: it takes a write lock on the sender's wallet, so concurrent sends queue up and each
      // one sees the others' transfers when the daily limit is checked below.
      await postEntry(session, {
        userId: senderId, wallet: 'SHOPPING', amountPaise: -input.amountPaise, type: 'P2P_OUT', refType: 'P2PTransfer', refId: tid,
        key: `p2p:${tid}:out`, note: `Sent to ${maskName(user.name)} (${member.memberCode})`, requireFunds: true,
      });
      const [{ sent }] = [...(await P2PTransfer.aggregate([
        { $match: { fromUserId: new Types.ObjectId(senderId), createdAt: { $gte: new Date(Date.now() - 86_400_000) } } },
        { $group: { _id: null, sent: { $sum: '$amountPaise' } } },
      ]).session(session)), { sent: 0 }];
      if (sent + input.amountPaise > cfg.dailyLimitPaise) {
        throw new HttpError(400, `This would exceed your daily limit of ₹${cfg.dailyLimitPaise / 100} (₹${sent / 100} already sent in the last 24 hours)`);
      }
      await postEntry(session, {
        userId: user._id, wallet: 'SHOPPING', amountPaise: input.amountPaise, type: 'P2P_IN', refType: 'P2PTransfer', refId: tid,
        key: `p2p:${tid}:in`, note: `Received from ${maskName(sender.name)}`,
      });
      const [t] = await P2PTransfer.create([{ _id: tid, fromUserId: senderId, toUserId: user._id, amountPaise: input.amountPaise, note: input.note, clientKey: input.clientKey }], { session });
      return serialize(t, senderId, new Map([[user._id.toString(), maskName(user.name)]]));
    });
  } catch (e: any) {
    if (e?.code === 11000 && input.clientKey) { const again = await retry(); if (again) return again; } // raced with an identical request
    throw e;
  }
}

export async function listP2P(userId: string, q: { direction: 'all' | 'sent' | 'received'; page: number; limit: number }) {
  const me = new Types.ObjectId(userId);
  const filter = q.direction === 'sent' ? { fromUserId: me } : q.direction === 'received' ? { toUserId: me } : { $or: [{ fromUserId: me }, { toUserId: me }] };
  const [rows, total, sentToday] = await Promise.all([
    P2PTransfer.find(filter).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    P2PTransfer.countDocuments(filter),
    P2PTransfer.aggregate([{ $match: { fromUserId: me, createdAt: { $gte: new Date(Date.now() - 86_400_000) } } }, { $group: { _id: null, n: { $sum: '$amountPaise' } } }]),
  ]);
  const ids = [...new Set(rows.flatMap((r) => [r.fromUserId.toString(), r.toUserId.toString()]))];
  const users = await User.find({ _id: { $in: ids } }).select('name').lean();
  const names = new Map(users.map((u) => [u._id.toString(), maskName(u.name)]));
  return {
    items: rows.map((r) => serialize(r, userId, names)), total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
    sentTodayPaise: sentToday[0]?.n ?? 0, dailyLimitPaise: p2pConfig().dailyLimitPaise,
  };
}

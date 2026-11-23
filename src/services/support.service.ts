/**
 * Help & support. Members and franchise owners raise tickets; the head office (admin) answers and resolves them.
 * Requesters see only their own tickets and never the admins' private notes.
 */
import { Types } from 'mongoose';
import { Counter, Franchise, Member, SupportTicket, TicketCategory, TicketPriority, TicketStatus, User } from '../models';
import { HttpError } from '../utils/http';
import { isStoredUrl } from './storage.service';

const DAY = 86_400_000;
export const MAX_OPEN_TICKETS = 5;      // per person, so the queue can't be flooded
const MAX_MESSAGES = 200;
const REOPEN_WINDOW_DAYS = 14;
const ACTIVE: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_USER'];
export const ticketNo = (n: number) => `SUP-${String(n).padStart(6, '0')}`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const nextNumber = async () => (await Counter.findOneAndUpdate({ _id: 'supportTicket' }, { $inc: { seq: 1 } }, { upsert: true, new: true })).seq;

/** Photos must be ones this app uploaded (support/ folder of our bucket), never a link to somewhere else. */
export function cleanAttachments(list?: string[]) {
  const out = [...new Set((list ?? []).map((u) => u.trim()).filter(Boolean))];
  if (out.length > 4) throw new HttpError(400, 'You can attach up to 4 photos to one message.');
  if (out.some((u) => !isStoredUrl(u, 'support'))) throw new HttpError(400, 'Photos must be uploaded through the app.');
  return out;
}

const preview = (t: any) => {
  const last = [...t.messages].reverse().find((m: any) => !m.internal);
  return last ? { from: last.from, text: (last.body || (last.attachments?.length ? '📷 Photo' : '')).slice(0, 140), at: last.createdAt } : null;
};

/** What the requester sees: the conversation without internal notes. */
const userView = (t: any) => ({
  id: t._id.toString(), number: ticketNo(t.number), subject: t.subject, category: t.category, priority: t.priority, status: t.status, orderRef: t.orderRef ?? null,
  createdAt: t.createdAt, updatedAt: t.lastMessageAt, resolvedAt: t.resolvedAt ?? null, closedAt: t.closedAt ?? null, assignedName: t.assignedName ?? null,
  needsYourReply: t.status === 'WAITING_ON_USER',
  canReopen: ['RESOLVED', 'CLOSED'].includes(t.status) && Date.now() - new Date(t.closedAt ?? t.resolvedAt ?? t.updatedAt).getTime() < REOPEN_WINDOW_DAYS * DAY,
  canRate: ['RESOLVED', 'CLOSED'].includes(t.status) && !t.rating?.stars, rating: t.rating?.stars ? { stars: t.rating.stars, comment: t.rating.comment ?? '' } : null,
  messages: t.messages.filter((m: any) => !m.internal).map((m: any) => ({ id: m._id.toString(), from: m.from, author: m.from === 'ADMIN' ? 'Support team' : m.authorName, body: m.body, attachments: m.attachments ?? [], at: m.createdAt })),
});

// ───────── requester (member or franchise owner) ─────────

export interface NewTicket { category: TicketCategory; subject: string; message: string; priority?: TicketPriority; orderRef?: string; attachments?: string[] }

export async function createTicket(userId: string, input: NewTicket) {
  const user = await User.findById(userId).select('name role');
  if (!user) throw new HttpError(404, 'User not found');
  const open = await SupportTicket.countDocuments({ creatorId: userId, status: { $in: ACTIVE } });
  if (open >= MAX_OPEN_TICKETS) throw new HttpError(400, `You already have ${MAX_OPEN_TICKETS} open tickets. Please wait for a reply, or close one that is solved, before opening another.`);
  const [member, franchise] = await Promise.all([
    user.role === 'MEMBER' ? Member.findOne({ userId }).select('memberCode franchiseId') : null,
    user.role.endsWith('FRANCHISE') ? Franchise.findOne({ $or: [{ ownerUserId: userId }, { staffUserIds: userId }] }).select('_id') : null,
  ]);
  const t = await SupportTicket.create({
    number: await nextNumber(), creatorId: userId, creatorRole: user.role, memberCode: member?.memberCode, franchiseId: member?.franchiseId ?? franchise?._id,
    category: input.category, priority: input.priority === 'HIGH' ? 'HIGH' : input.priority === 'LOW' ? 'LOW' : 'NORMAL', // only the head office can mark something URGENT
    subject: input.subject, orderRef: input.orderRef || undefined, status: 'OPEN', lastMessageFrom: 'USER',
    messages: [{ authorId: userId, from: 'USER', authorName: user.name, body: input.message, attachments: cleanAttachments(input.attachments) }],
  });
  return userView(t);
}

export async function listMine(userId: string, q: { view: 'open' | 'closed' | 'all'; page: number; limit: number }) {
  const filter: Record<string, unknown> = { creatorId: userId, ...(q.view === 'open' ? { status: { $in: ACTIVE } } : q.view === 'closed' ? { status: { $in: ['RESOLVED', 'CLOSED'] } } : {}) };
  const [rows, total, needsReply] = await Promise.all([
    SupportTicket.find(filter).sort({ lastMessageAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    SupportTicket.countDocuments(filter),
    SupportTicket.countDocuments({ creatorId: userId, status: 'WAITING_ON_USER' }),
  ]);
  return {
    items: rows.map((t) => ({ id: t._id.toString(), number: ticketNo(t.number), subject: t.subject, category: t.category, status: t.status, updatedAt: t.lastMessageAt, createdAt: t.createdAt, needsYourReply: t.status === 'WAITING_ON_USER', last: preview(t) })),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)), needsReply,
  };
}

async function mine(userId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new HttpError(404, 'Ticket not found');
  const t = await SupportTicket.findOne({ _id: id, creatorId: userId });
  if (!t) throw new HttpError(404, 'Ticket not found');
  return t;
}

export async function getMine(userId: string, id: string) { return userView(await mine(userId, id)); }

export async function replyMine(userId: string, id: string, body: string, attachments?: string[]) {
  const t = await mine(userId, id);
  if (t.status === 'CLOSED') throw new HttpError(409, 'This ticket is closed. Reopen it to reply, or start a new one.');
  if (t.messages.length >= MAX_MESSAGES) throw new HttpError(400, 'This conversation is very long. Please open a new ticket.');
  const photos = cleanAttachments(attachments);
  const user = await User.findById(userId).select('name');
  // Their reply puts it back in the head office's queue.
  const status: TicketStatus = ['WAITING_ON_USER', 'RESOLVED'].includes(t.status) ? 'OPEN' : t.status;
  const u = await SupportTicket.findOneAndUpdate(
    { _id: t._id, status: { $ne: 'CLOSED' } },
    { $push: { messages: { authorId: userId, from: 'USER', authorName: user!.name, body, attachments: photos } }, $set: { status, lastMessageAt: new Date(), lastMessageFrom: 'USER' }, $unset: t.status === 'RESOLVED' ? { resolvedAt: 1 } : {} },
    { new: true },
  );
  if (!u) throw new HttpError(409, 'This ticket was just closed.');
  return userView(u);
}

export async function closeMine(userId: string, id: string) {
  const t = await mine(userId, id);
  if (t.status === 'CLOSED') return userView(t);
  t.status = 'CLOSED'; t.closedAt = new Date();
  await t.save();
  return userView(t);
}

export async function reopenMine(userId: string, id: string) {
  const t = await mine(userId, id);
  const v = userView(t);
  if (!v.canReopen) throw new HttpError(409, `A ticket can be reopened within ${REOPEN_WINDOW_DAYS} days of being solved. Please open a new one.`);
  t.status = 'OPEN'; t.reopenCount += 1; t.lastMessageAt = new Date(); t.lastMessageFrom = 'USER'; t.resolvedAt = undefined; t.closedAt = undefined;
  await t.save();
  return userView(t);
}

export async function rateMine(userId: string, id: string, stars: number, comment?: string) {
  const t = await mine(userId, id);
  if (!['RESOLVED', 'CLOSED'].includes(t.status)) throw new HttpError(409, 'You can rate the help once the ticket is solved.');
  const u = await SupportTicket.findOneAndUpdate({ _id: t._id, 'rating.stars': { $exists: false } }, { $set: { rating: { stars, comment, at: new Date() } } }, { new: true });
  if (!u) throw new HttpError(409, 'You have already rated this ticket.');
  return userView(u);
}

export async function summaryMine(userId: string) {
  const [open, needsReply] = await Promise.all([SupportTicket.countDocuments({ creatorId: userId, status: { $in: ACTIVE } }), SupportTicket.countDocuments({ creatorId: userId, status: 'WAITING_ON_USER' })]);
  return { open, needsReply };
}

// ───────── head office ─────────

export interface AdminQuery { status?: TicketStatus | 'active'; category?: TicketCategory; priority?: TicketPriority; who?: 'member' | 'franchise'; assigned?: 'me' | 'unassigned'; search?: string; sort?: 'newest' | 'oldest'; page: number; limit: number }

export async function adminList(adminId: string, q: AdminQuery) {
  const f: Record<string, unknown> = {};
  if (q.status === 'active') f.status = { $in: ACTIVE }; else if (q.status) f.status = q.status;
  if (q.category) f.category = q.category;
  if (q.priority) f.priority = q.priority;
  if (q.who) f.creatorRole = q.who === 'member' ? 'MEMBER' : { $in: ['ZONAL_FRANCHISE', 'REMOTE_FRANCHISE'] };
  if (q.assigned === 'me') f.assignedTo = adminId; else if (q.assigned === 'unassigned') f.assignedTo = { $exists: false };
  if (q.search) {
    const digits = q.search.replace(/\D/g, '');
    const users = await User.find({ name: { $regex: escape(q.search), $options: 'i' } }).select('_id').limit(50).lean();
    f.$or = [{ subject: { $regex: escape(q.search), $options: 'i' } }, { memberCode: q.search.toUpperCase() }, { creatorId: { $in: users.map((u) => u._id) } }, ...(digits ? [{ number: Number(digits) }] : [])];
  }
  const [rows, total] = await Promise.all([
    SupportTicket.find(f).sort({ lastMessageAt: q.sort === 'oldest' ? 1 : -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    SupportTicket.countDocuments(f),
  ]);
  const people = await User.find({ _id: { $in: rows.map((r) => r.creatorId) } }).select('name').lean();
  const frs = await Franchise.find({ _id: { $in: rows.map((r) => r.franchiseId).filter(Boolean) } }).select('code').lean();
  return {
    items: rows.map((t) => ({
      id: t._id.toString(), number: ticketNo(t.number), subject: t.subject, category: t.category, priority: t.priority, status: t.status, createdAt: t.createdAt, updatedAt: t.lastMessageAt,
      from: { name: people.find((p) => p._id.equals(t.creatorId))?.name ?? 'User', kind: t.creatorRole === 'MEMBER' ? 'MEMBER' : 'FRANCHISE', memberCode: t.memberCode ?? null, franchiseCode: frs.find((x) => t.franchiseId && x._id.equals(t.franchiseId))?.code ?? null },
      assignedName: t.assignedName ?? null, waitingOnUs: ACTIVE.includes(t.status as TicketStatus) && t.status !== 'WAITING_ON_USER' && t.lastMessageFrom === 'USER',
      ageHours: Math.round((Date.now() - new Date(t.lastMessageAt).getTime()) / 3_600_000), messageCount: t.messages.length, last: preview(t),
      photos: (() => { const all = t.messages.flatMap((m: any) => m.attachments ?? []); return { count: all.length, urls: all.slice(0, 3) }; })(),
    })),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
  };
}

export async function adminGet(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new HttpError(404, 'Ticket not found');
  const t = await SupportTicket.findById(id).lean();
  if (!t) throw new HttpError(404, 'Ticket not found');
  const [u, fr, others] = await Promise.all([
    User.findById(t.creatorId).select('name email phone status role createdAt').lean(),
    t.franchiseId ? Franchise.findById(t.franchiseId).select('code name').lean() : null,
    SupportTicket.find({ creatorId: t.creatorId, _id: { $ne: t._id } }).sort({ createdAt: -1 }).limit(5).select('number subject status createdAt').lean(),
  ]);
  return {
    ...userView(t as any),
    internalNotes: t.messages.filter((m: any) => m.internal).length,
    messages: t.messages.map((m: any) => ({ id: m._id.toString(), from: m.from, author: m.authorName, body: m.body, attachments: m.attachments ?? [], at: m.createdAt, internal: !!m.internal })),
    firstResponseMinutes: t.firstResponseAt ? Math.round((new Date(t.firstResponseAt).getTime() - new Date(t.createdAt).getTime()) / 60_000) : null,
    reopenCount: t.reopenCount, assignedToId: t.assignedTo?.toString() ?? null,
    requester: { name: u?.name ?? 'User', email: u?.email, phone: u?.phone, status: u?.status, role: t.creatorRole, memberCode: t.memberCode ?? null, franchise: fr ? { code: fr.code, name: fr.name } : null, since: u?.createdAt },
    otherTickets: others.map((o) => ({ id: o._id.toString(), number: ticketNo(o.number), subject: o.subject, status: o.status, createdAt: o.createdAt })),
  };
}

export async function adminReply(adminId: string, id: string, i: { body: string; internal?: boolean; status?: TicketStatus; attachments?: string[] }) {
  const t = await SupportTicket.findById(id);
  if (!t) throw new HttpError(404, 'Ticket not found');
  if (t.status === 'CLOSED' && !i.internal) throw new HttpError(409, 'This ticket is closed. Ask the user to reopen it, or reopen it here first.');
  if (t.messages.length >= MAX_MESSAGES) throw new HttpError(400, 'This conversation is very long. Ask the user to open a new ticket.');
  const admin = await User.findById(adminId).select('name');
  const now = new Date();
  const set: Record<string, unknown> = {};
  if (!i.internal) {
    // Answering the user: by default the ball goes back to them. Marking it solved is a deliberate choice.
    set.status = i.status ?? (t.status === 'RESOLVED' ? 'RESOLVED' : 'WAITING_ON_USER');
    set.lastMessageAt = now; set.lastMessageFrom = 'ADMIN';
    if (!t.firstResponseAt) set.firstResponseAt = now;
    if (set.status === 'RESOLVED' && t.status !== 'RESOLVED') set.resolvedAt = now;
  }
  if (!t.assignedTo) { set.assignedTo = adminId; set.assignedName = admin?.name; } // whoever answers first takes it
  const u = await SupportTicket.findByIdAndUpdate(id, { $push: { messages: { authorId: adminId, from: 'ADMIN', authorName: admin?.name ?? 'Support', body: i.body, attachments: cleanAttachments(i.attachments), internal: !!i.internal } }, $set: set }, { new: true });
  return adminGet(u!._id.toString());
}

export async function adminUpdate(adminId: string, id: string, i: { status?: TicketStatus; priority?: TicketPriority; category?: TicketCategory; assign?: 'me' | 'none' }) {
  const t = await SupportTicket.findById(id);
  if (!t) throw new HttpError(404, 'Ticket not found');
  const before = { status: t.status, priority: t.priority, category: t.category, assignedTo: t.assignedTo };
  if (i.priority) t.priority = i.priority;
  if (i.category) t.category = i.category;
  if (i.assign === 'me') { t.assignedTo = new Types.ObjectId(adminId); t.assignedName = (await User.findById(adminId).select('name'))?.name; }
  if (i.assign === 'none') { t.assignedTo = undefined; t.assignedName = undefined; }
  if (i.status && i.status !== t.status) {
    t.status = i.status;
    if (i.status === 'RESOLVED') t.resolvedAt = new Date();
    if (i.status === 'CLOSED') t.closedAt = new Date();
    if (['OPEN', 'IN_PROGRESS', 'WAITING_ON_USER'].includes(i.status)) { t.resolvedAt = undefined; t.closedAt = undefined; }
  }
  await t.save();
  return { before, ticket: await adminGet(id) };
}

export async function adminSummary(adminId: string) {
  const now = Date.now();
  const [byStatus, unassigned, urgent, mineOpen, overdue, ratings, needsUs] = await Promise.all([
    SupportTicket.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    SupportTicket.countDocuments({ status: { $in: ACTIVE }, assignedTo: { $exists: false } }),
    SupportTicket.countDocuments({ status: { $in: ACTIVE }, priority: 'URGENT' }),
    SupportTicket.countDocuments({ status: { $in: ACTIVE }, assignedTo: adminId }),
    SupportTicket.countDocuments({ status: { $in: ['OPEN', 'IN_PROGRESS'] }, lastMessageFrom: 'USER', lastMessageAt: { $lt: new Date(now - DAY) } }),
    SupportTicket.aggregate([{ $match: { 'rating.stars': { $exists: true } } }, { $group: { _id: null, avg: { $avg: '$rating.stars' }, n: { $sum: 1 } } }]),
    SupportTicket.countDocuments({ status: { $in: ['OPEN', 'IN_PROGRESS'] }, lastMessageFrom: 'USER' }),
  ]);
  const c = (s: string) => byStatus.find((x) => x._id === s)?.n ?? 0;
  return { open: c('OPEN'), inProgress: c('IN_PROGRESS'), waitingOnUser: c('WAITING_ON_USER'), resolved: c('RESOLVED'), closed: c('CLOSED'), unassigned, urgent, mine: mineOpen, overdue, needsReply: needsUs, rating: ratings[0] ? { average: Math.round(ratings[0].avg * 10) / 10, count: ratings[0].n } : null };
}

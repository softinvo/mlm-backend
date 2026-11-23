import { Request, Response } from 'express';
import { z } from 'zod';
import { AuditLog, TicketCategories, TicketPriorities, TicketStatuses } from '../models';
import * as support from '../services/support.service';

const id = (req: Request) => req.params.id as string;
const page = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(10) };
const photos = z.array(z.string().url().max(500)).max(4, 'You can attach up to 4 photos').optional();
const text = (min: number, max: number, what: string) => z.string({ message: `${what} is required` }).trim().min(min, `${what} is too short`).max(max, `${what} is too long`);

// ───────── a member or franchise owner, on their own tickets ─────────

export const createTicket = async (req: Request, res: Response) => {
  const b = z.object({
    category: z.enum(TicketCategories), subject: text(5, 120, 'Subject'), message: text(10, 4000, 'Message'),
    priority: z.enum(TicketPriorities).optional(), orderRef: z.string().trim().max(30).optional(), attachments: photos,
  }).parse(req.body);
  const t = await support.createTicket(req.auth!.userId, b);
  res.status(201).json(t);
};
export const myTickets = async (req: Request, res: Response) => res.json(await support.listMine(req.auth!.userId, z.object({ ...page, view: z.enum(['open', 'closed', 'all']).default('all') }).parse(req.query)));
export const mySupportSummary = async (req: Request, res: Response) => res.json(await support.summaryMine(req.auth!.userId));
export const myTicket = async (req: Request, res: Response) => res.json(await support.getMine(req.auth!.userId, id(req)));
/** A reply needs words or a photo (or both). */
const replyBody = z.object({ message: z.string().trim().max(4000, 'Message is too long').default(''), attachments: photos })
  .refine((b) => b.message.length > 0 || (b.attachments?.length ?? 0) > 0, { message: 'Write a message or attach a photo', path: ['message'] });
export const replyTicket = async (req: Request, res: Response) => { const b = replyBody.parse(req.body); res.json(await support.replyMine(req.auth!.userId, id(req), b.message, b.attachments)); };
export const closeTicket = async (req: Request, res: Response) => res.json(await support.closeMine(req.auth!.userId, id(req)));
export const reopenTicket = async (req: Request, res: Response) => res.json(await support.reopenMine(req.auth!.userId, id(req)));
export const rateTicket = async (req: Request, res: Response) => {
  const b = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() }).parse(req.body);
  res.json(await support.rateMine(req.auth!.userId, id(req), b.stars, b.comment));
};

// ───────── head office ─────────

export const adminTickets = async (req: Request, res: Response) => {
  const q = z.object({
    ...page, limit: z.coerce.number().int().min(1).max(100).default(15),
    status: z.enum([...TicketStatuses, 'active']).optional(), category: z.enum(TicketCategories).optional(), priority: z.enum(TicketPriorities).optional(),
    who: z.enum(['member', 'franchise']).optional(), assigned: z.enum(['me', 'unassigned']).optional(), search: z.string().trim().max(60).optional(), sort: z.enum(['newest', 'oldest']).optional(),
  }).parse(req.query);
  res.json(await support.adminList(req.auth!.userId, q));
};
export const adminSupportSummary = async (req: Request, res: Response) => res.json(await support.adminSummary(req.auth!.userId));
export const adminTicket = async (req: Request, res: Response) => res.json(await support.adminGet(id(req)));
export const adminReplyTicket = async (req: Request, res: Response) => {
  const b = replyBody.and(z.object({ internal: z.boolean().optional(), status: z.enum(['IN_PROGRESS', 'WAITING_ON_USER', 'RESOLVED']).optional() })).parse(req.body);
  const t = await support.adminReply(req.auth!.userId, id(req), { body: b.message, internal: b.internal, status: b.status, attachments: b.attachments });
  await AuditLog.create({ actorId: req.auth!.userId, action: b.internal ? 'TICKET_NOTE' : 'TICKET_REPLY', entity: 'SupportTicket', entityId: id(req), after: { status: t.status } });
  res.json(t);
};
export const adminUpdateTicket = async (req: Request, res: Response) => {
  const b = z.object({ status: z.enum(TicketStatuses).optional(), priority: z.enum(TicketPriorities).optional(), category: z.enum(TicketCategories).optional(), assign: z.enum(['me', 'none']).optional() }).parse(req.body);
  const { before, ticket } = await support.adminUpdate(req.auth!.userId, id(req), b);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'TICKET_UPDATED', entity: 'SupportTicket', entityId: id(req), before, after: b });
  res.json(ticket);
};

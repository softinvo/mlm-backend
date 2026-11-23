import { Schema, model } from 'mongoose';

export const TicketStatuses = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_USER', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatus = (typeof TicketStatuses)[number];
export const TicketCategories = ['ORDER', 'PAYMENT', 'TOPUP', 'WITHDRAWAL', 'KYC', 'ACCOUNT', 'COMMISSION', 'STOCK', 'RECHARGE', 'OTHER'] as const;
export type TicketCategory = (typeof TicketCategories)[number];
export const TicketPriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TicketPriorities)[number];

/** Gives each ticket a short, human number (SUP-000123) without two tickets ever getting the same one. */
const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });
export const Counter = model('Counter', counterSchema);

const messageSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    from: { type: String, enum: ['USER', 'ADMIN'], required: true },
    authorName: { type: String, required: true },
    body: { type: String, required: true, maxlength: 4000 },
    attachments: { type: [String], default: [] },    // photos (screenshots, receipts), stored in our bucket
    internal: { type: Boolean, default: false },   // a private note between admins: the requester never sees it
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

/** A help request from a member or a franchise owner, answered by the head office. */
const ticketSchema = new Schema(
  {
    number: { type: Number, required: true, unique: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    creatorRole: { type: String, required: true },          // MEMBER | ZONAL_FRANCHISE | REMOTE_FRANCHISE
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise' },
    memberCode: String,
    category: { type: String, enum: TicketCategories, required: true },
    priority: { type: String, enum: TicketPriorities, default: 'NORMAL' },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    orderRef: { type: String, trim: true, maxlength: 30 },  // the order number the problem is about, if any
    status: { type: String, enum: TicketStatuses, default: 'OPEN' },
    messages: { type: [messageSchema], validate: (v: unknown[]) => v.length > 0 },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedName: String,
    firstResponseAt: Date,
    lastMessageAt: { type: Date, default: Date.now },
    lastMessageFrom: { type: String, enum: ['USER', 'ADMIN'], default: 'USER' },
    resolvedAt: Date,
    closedAt: Date,
    reopenCount: { type: Number, default: 0 },
    rating: { stars: { type: Number, min: 1, max: 5 }, comment: { type: String, maxlength: 500 }, at: Date },
  },
  { timestamps: true },
);
ticketSchema.index({ creatorId: 1, lastMessageAt: -1 });
ticketSchema.index({ status: 1, lastMessageAt: -1 });
export const SupportTicket = model('SupportTicket', ticketSchema);

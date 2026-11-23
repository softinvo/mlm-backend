import { Schema, model } from 'mongoose';

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.index({ entity: 1, entityId: 1 });
export const AuditLog = model('AuditLog', auditLogSchema);

import { Schema, model } from 'mongoose';

/** The public website's content, managed from the admin app. One document; see services/site.service.ts for its shape. */
const siteSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'site' },
    content: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const SiteContent = model('SiteContent', siteSchema);

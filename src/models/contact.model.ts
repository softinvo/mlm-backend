import { Schema, model } from 'mongoose';

/** A message sent from the public website's contact form. The head office reads these in the admin Support Desk. */
const contactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 15 },
    subject: { type: String, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    status: { type: String, enum: ['NEW', 'HANDLED'], default: 'NEW' },
    handledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    handledAt: Date,
  },
  { timestamps: true },
);
contactSchema.index({ status: 1, createdAt: -1 });
export const ContactMessage = model('ContactMessage', contactSchema);

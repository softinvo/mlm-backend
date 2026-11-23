import { Schema, model } from 'mongoose';

/** A photo on the public website's Photo Gallery, managed by the head office. */
const gallerySchema = new Schema(
  {
    imageUrl: { type: String, required: true },
    caption: { type: String, trim: true, maxlength: 140, default: '' },
    order: { type: Number, default: 0 },          // lowest first
    active: { type: Boolean, default: true },      // hidden photos stay in the admin list but not on the website
  },
  { timestamps: true },
);
gallerySchema.index({ order: 1, createdAt: 1 });
export const GalleryPhoto = model('GalleryPhoto', gallerySchema);

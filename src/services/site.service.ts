/**
 * The public website's content: site-wide settings (name, contact, colours) and six pages, each a list of blocks the head office
 * can add, edit, reorder and hide. Stored as one document; validated here so a bad edit can never break the public site.
 */
import { z } from 'zod';
import { SiteContent } from '../models';
import { DEFAULT_SITE } from './site.defaults';
import { DEFAULT_NAV } from './site.nav';
import { isStoredUrl } from './storage.service';

export const PAGE_KEYS = ['home', 'about', 'products', 'franchise', 'opportunity', 'gallery', 'contact'] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

const short = (max: number) => z.string().trim().max(max);
const linkTo = short(300).refine((v) => v === '' || /^(\/|#|https?:\/\/|mailto:|tel:)/.test(v), 'A link must start with /, #, https://, mailto: or tel:');
const link = z.object({ label: short(60), to: linkTo });
const image = short(500).refine((u) => u === '' || isStoredUrl(u), 'Upload pictures through the app so they are stored in your bucket');
const color = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #123b2b');
const base = { id: short(60).min(1), visible: z.boolean() };
const noLink = { label: '', to: '' };
/** Optional text-ish fields default to empty so content saved before a field existed still validates. */
const opt = (max: number) => short(max).default('');
const arr = <T extends z.ZodTypeAny>(t: T, max: number) => z.array(t).max(max);

export const blockSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('pagehero'), kicker: short(60), title: short(160), text: short(600), primary: link.default(noLink), secondary: link.default(noLink) }),
  z.object({ ...base, type: z.literal('hero'), kicker: short(80), title: short(200), text: short(700), primary: link, secondary: link, noteText: short(120), noteLink: link, imageUrl: image }),
  z.object({ ...base, type: z.literal('strip'), items: arr(z.object({ label: short(60), text: short(140) }), 6) }),
  z.object({ ...base, type: z.literal('cards'), kicker: short(60), title: short(160), intro: short(600), columns: z.union([z.literal(2), z.literal(3), z.literal(4)]), cta: link.default(noLink),
    cards: arr(z.object({ title: short(100), text: short(600), imageUrl: image, link, tag: opt(60), badge: opt(40), note: opt(240), listLabel: opt(40), list: arr(short(120), 10).default([]) }), 16) }),
  z.object({ ...base, type: z.literal('stats'), kicker: opt(60), title: opt(160), intro: opt(500), items: arr(z.object({ value: short(24), label: short(100) }), 8), note: opt(400), cta: link.default(noLink) }),
  z.object({ ...base, type: z.literal('chips'), kicker: opt(60), title: opt(160), intro: opt(500), items: arr(short(80), 16), cta: link.default(noLink) }),
  z.object({ ...base, type: z.literal('callout'), label: short(40), value: short(40), title: short(120), text: opt(200) }),
  z.object({ ...base, type: z.literal('quote'), kicker: opt(60), title: short(160), intro: opt(500), products: arr(short(60), 20), roles: arr(short(60), 8), successText: opt(300) }),
  z.object({ ...base, type: z.literal('products'), kicker: short(60), title: short(160), intro: short(500), show: z.enum(['all', 'kits', 'products']), limit: z.number().int().min(0).max(60), tabs: z.boolean(), cta: link }),
  z.object({ ...base, type: z.literal('split'), kicker: short(60), title: short(160), text: short(1200), bullets: arr(short(200), 8), imageUrl: image, imageSide: z.enum(['left', 'right']), cta: link }),
  z.object({ ...base, type: z.literal('steps'), kicker: short(60), title: short(160), intro: short(400), steps: arr(z.object({ title: short(80), text: short(300) }), 8) }),
  z.object({ ...base, type: z.literal('faq'), kicker: short(60), title: short(160), items: arr(z.object({ q: short(200), a: short(1200) }), 20) }),
  z.object({ ...base, type: z.literal('levels'), kicker: short(60), title: short(160), intro: short(500), note: short(300) }),
  z.object({ ...base, type: z.literal('gallery'), includeProducts: z.boolean(), kicker: opt(60), title: opt(160), intro: opt(500), limit: z.number().int().min(0).max(60).default(0), cta: link.default(noLink) }),
  z.object({ ...base, type: z.literal('cashback'), kicker: opt(60), title: short(160), intro: opt(600), note: opt(300), cta: link.default(noLink) }),
  z.object({ ...base, type: z.literal('plans'), kicker: opt(60), title: short(160), intro: opt(600), note: opt(300), cta: link.default(noLink) }),
  z.object({ ...base, type: z.literal('contact'), formTitle: short(80), infoTitle: short(80), infoNote: short(300) }),
  z.object({ ...base, type: z.literal('cta'), title: short(160), text: short(400), primary: link, secondary: link }),
  z.object({ ...base, type: z.literal('text'), kicker: short(60), title: short(160), paragraphs: arr(short(2000), 10) }),
]);

const settingsSchema = z.object({
  name: short(60).min(2, 'Enter your company name'), tagline: short(160), logoUrl: image,
  email: short(120), phone: short(30), whatsapp: opt(20), address: short(200), hours: short(80),
  footerAbout: short(300), footerNote: opt(400), disclaimer: opt(400),
  nav: arr(z.object({ label: short(40).min(1), to: linkTo.refine((v) => v !== '', 'Every menu item needs a link') }), 14).default(DEFAULT_NAV),
  theme: z.object({ forest: color, forestDeep: color, cream: color, card: color, sage: color, line: color, gold: color, mute: color }),
});

export const siteSchema = z.object({
  settings: settingsSchema,
  pages: z.object(Object.fromEntries(PAGE_KEYS.map((k) => [k, arr(blockSchema, 30)])) as Record<PageKey, z.ZodArray<typeof blockSchema>>),
}).superRefine((v, ctx) => {
  // block ids must be unique inside a page (the editor and the public site key lists by them)
  for (const k of PAGE_KEYS) {
    const ids = v.pages[k].map((b) => b.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `Two blocks on the ${k} page share an id`, path: ['pages', k] });
  }
});

export type SiteContentData = z.infer<typeof siteSchema>;
export type Block = z.infer<typeof blockSchema>;

/** The saved content, with anything missing (a new page, a new colour) filled from the defaults so the site never renders half-empty. */
export async function getSite(): Promise<{ content: SiteContentData; customised: boolean; updatedAt: Date | null }> {
  const doc = await SiteContent.findOne({ key: 'site' }).lean();
  const saved = (doc?.content ?? {}) as Partial<SiteContentData>;
  const content: SiteContentData = {
    settings: { ...DEFAULT_SITE.settings, ...(saved.settings ?? {}), theme: { ...DEFAULT_SITE.settings.theme, ...(saved.settings?.theme ?? {}) } },
    pages: Object.fromEntries(PAGE_KEYS.map((k) => [k, saved.pages?.[k] ?? DEFAULT_SITE.pages[k]])) as SiteContentData['pages'],
  };
  // Retired pages (Ginger, Certifications, Sourcing) are dropped from content saved earlier, menu items and blocks,  so nobody has to re-save.
  content.settings.nav = content.settings.nav.filter((n) => !['/ginger', '/organic-network', '/sourcing-processing'].includes(n.to));
  for (const k of PAGE_KEYS) content.pages[k] = content.pages[k].filter((b) => !/ginger/i.test(b.id) && b.id !== 'home-range');
  return { content, customised: !!doc, updatedAt: doc?.updatedAt ?? null };
}

export async function saveSite(content: SiteContentData, userId: string) {
  await SiteContent.findOneAndUpdate({ key: 'site' }, { $set: { content, updatedBy: userId } }, { upsert: true, new: true });
}

export const resetSite = () => SiteContent.deleteOne({ key: 'site' });

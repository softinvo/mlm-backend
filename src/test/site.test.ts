import './upload-env';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AuditLog, User, Wallet } from '../models';
import { signToken } from '../utils/jwt';

let rs: MongoMemoryReplSet;
let server: import('node:http').Server;
let base = '';
before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = rs.getUri();
  process.env.JWT_SECRET = 'test-secret-test-secret-123456';
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const { app } = await import('../app');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { server.close(); await mongoose.disconnect(); await rs.stop(); });

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
let admin = '', member = '';
beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  const mk = async (role: any, name: string) => { const u = await User.create({ role, status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9300000000 + Math.floor(Math.random() * 9999999)), passwordHash: await bcrypt.hash('Passw0rd!', 4) }); await Wallet.create({ userId: u._id, type: 'INCOME' }); return signToken({ userId: u._id.toString(), role }); };
  admin = await mk('SUPER_ADMIN', 'admin'); member = await mk('MEMBER', 'mem');
});

describe('website content (managed from the admin app)', () => {
  it('serves sensible defaults to anyone, with the forest, cream and gold palette', async () => {
    const r = await call(null, 'GET', '/public/site');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body.pages).sort(), ['about', 'contact', 'franchise', 'gallery', 'home', 'opportunity', 'products']);
    assert.deepEqual(r.body.settings.nav.map((n: any) => n.to), ['/', '/about', '/products', '/franchise', '/opportunity', '/gallery', '/contact'], 'every page is in the menu');
    const types = new Set(Object.values(r.body.pages).flatMap((p: any) => p.map((b: any) => b.type)));
    for (const t of ['hero', 'cards', 'quote', 'steps', 'split', 'products', 'levels', 'faq', 'gallery', 'contact', 'cta', 'pagehero', 'strip', 'text', 'plans']) assert.ok(types.has(t), `the defaults use a ${t} block`);
    assert.match(JSON.stringify(r.body), /\{\{name\}\}/, 'the company name is a token, so one setting renames the whole site');
    assert.equal(r.body.settings.theme.forest, '#123b2b');
    assert.equal(r.body.pages.home[0].type, 'hero');
    assert.doesNotMatch(JSON.stringify(r.body), /ginger|organic|NPOP|FPC|neiom|exporter/i, 'the defaults describe this platform, not another business');
    assert.equal(r.body.pages.contact.find((b: any) => b.type === 'quote').id, 'enquire', 'the quote form is the #enquire anchor');
    assert.ok(r.body.pages.home.every((b: any) => b.id && typeof b.visible === 'boolean'));
  });

  it('lets only the admin edit it; edits show publicly; reset goes back to the defaults', async () => {
    const cur = (await call(admin, 'GET', '/admin/site')).body;
    assert.equal(cur.customised, false);
    assert.equal((await call(member, 'GET', '/admin/site')).status, 403);
    assert.equal((await call(member, 'PUT', '/admin/site', cur.content)).status, 403);

    const next = structuredClone(cur.content);
    next.settings.name = 'Neiom Naturals'; next.settings.theme.gold = '#c9a45c';
    next.pages.home[0].title = 'Organic produce, straight from the farm';
    next.pages.home[1].visible = false;
    next.pages.home.push({ id: 'extra-text', type: 'text', visible: true, kicker: 'Note', title: 'A note', paragraphs: ['Hello there.'] });
    const ok = await call(admin, 'PUT', '/admin/site', next);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const pub = (await call(null, 'GET', '/public/site')).body;
    assert.equal(pub.settings.name, 'Neiom Naturals');
    assert.equal(pub.settings.theme.gold, '#c9a45c');
    assert.equal(pub.pages.home[0].title, 'Organic produce, straight from the farm');
    assert.equal(pub.pages.home[1].visible, false);
    assert.equal(pub.pages.home.at(-1).id, 'extra-text');
    assert.equal((await call(admin, 'GET', '/admin/site')).body.customised, true);
    assert.ok(await AuditLog.exists({ action: 'SITE_UPDATED' }));

    assert.equal((await call(admin, 'POST', '/admin/site/reset')).status, 200);
    assert.equal((await call(null, 'GET', '/public/site')).body.settings.name, 'Our Company');
  });

  it('refuses edits that could break the site: bad colours, bad links, pictures from elsewhere, duplicate ids, unknown blocks', async () => {
    const cur = (await call(admin, 'GET', '/admin/site')).body.content;
    const put = (mut: (c: any) => void) => { const c = structuredClone(cur); mut(c); return call(admin, 'PUT', '/admin/site', c); };
    assert.equal((await put((c) => { c.settings.theme.forest = 'green'; })).status, 400, 'a colour must be #rrggbb');
    assert.equal((await put((c) => { c.settings.name = ''; })).status, 400);
    assert.equal((await put((c) => { c.pages.home[0].primary.to = 'javascript:alert(1)'; })).status, 400, 'script links are refused');
    assert.equal((await put((c) => { c.pages.home[0].imageUrl = 'https://evil.example.com/x.jpg'; })).status, 400, 'only our own bucket');
    assert.equal((await put((c) => { c.pages.home.push({ ...c.pages.home[0] }); })).status, 400, 'duplicate block ids');
    assert.equal((await put((c) => { c.pages.home.push({ id: 'x', type: 'script', visible: true }); })).status, 400, 'unknown block type');
    assert.equal((await put((c) => { c.pages.home[0].title = 'x'.repeat(500); })).status, 400, 'too long');
    assert.equal((await put((c) => { c.pages.home[0].imageUrl = 'https://files.example.com/site/abc.jpg'; c.pages.home[0].primary.to = 'https://example.com/shop'; })).status, 200, 'our pictures and normal links are fine');
  });

  it('accepts content saved before newer fields existed (cards without tags, settings without a menu)', async () => {
    const cur = (await call(admin, 'GET', '/admin/site')).body.content;
    const old = structuredClone(cur);
    delete old.settings.nav; delete old.settings.whatsapp; delete old.settings.footerNote;
    for (const b of old.pages.home) if (b.type === 'cards') { b.cards = b.cards.map((c: any) => ({ title: c.title, text: c.text, imageUrl: '', link: c.link })); delete b.cta; }
    const r = await call(admin, 'PUT', '/admin/site', old);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pub = (await call(null, 'GET', '/public/site')).body;
    assert.equal(pub.settings.nav.length, 7, 'the default menu fills in');
  });

  it('fills in anything missing so the public site never renders half-empty', async () => {
    const { SiteContent } = await import('../models');
    await SiteContent.create({ key: 'site', content: { settings: { name: 'Only Name' }, pages: { home: [] } } });
    const pub = (await call(null, 'GET', '/public/site')).body;
    assert.equal(pub.settings.name, 'Only Name');
    assert.equal(pub.settings.email, 'support@example.com', 'missing settings come from the defaults');
    assert.equal(pub.settings.theme.cream, '#f7f5ee');
    assert.deepEqual(pub.pages.home, [], 'a page the admin emptied stays empty');
    assert.ok(pub.pages.about.length > 0, 'pages never saved use the defaults');
  });
});

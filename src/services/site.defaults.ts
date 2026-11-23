import { DEFAULT_NAV } from './site.nav';
import type { SiteContentData } from './site.service';

/**
 * What the website shows until the head office edits it: a direct-selling company whose products are sold through local
 * franchises, with members earning commission on verified retail sales. Nothing here is a factual claim about a real
 * business (no certificates, no figures), so change the wording to match yours in Admin → Website Content.
 * `{{name}}` is replaced with the company name from Settings.
 */
const L = (label: string, to: string) => ({ label, to });
const none = L('', '');
const enquire = L('Send an enquiry', '/contact#enquire');
const card = (title: string, text: string, x: Partial<{ tag: string; badge: string; note: string; listLabel: string; list: string[]; link: { label: string; to: string } }> = {}) =>
  ({ title, text, imageUrl: '', link: x.link ?? none, tag: x.tag ?? '', badge: x.badge ?? '', note: x.note ?? '', listLabel: x.listLabel ?? '', list: x.list ?? [] });

const ENQUIRY = (id: string, title = 'Send an enquiry', kicker = 'Enquiries & contact') => ({
  id, type: 'quote' as const, visible: true, kicker, title,
  intro: 'Questions about our products, joining as a member or opening a franchise? Tell us what you need and the {{name}} team will get back to you.',
  products: ['Joining kit', 'Products to repurchase', 'Becoming a member', 'Opening a franchise', 'Something else'],
  roles: ['Customer', 'Prospective member', 'Franchise applicant', 'Other'], successText: 'Thank you. The {{name}} team will get back to you shortly.',
});
const JOIN_CTA = (id: string) => ({ id, type: 'cta' as const, visible: true, title: 'Become part of the network', text: 'Create your account in a minute with a sponsor code and the code of a franchise near you.', primary: L('Sign up', '/register'), secondary: L('Sign in', '/login') });
const HOW = [
  { title: 'Join', text: 'Sign up with a sponsor code and the code of your franchise.' },
  { title: 'Shop', text: 'Buy your joining kit and repurchase products at a franchise near you, or with your shopping wallet.' },
  { title: 'Share', text: 'Introduce the products to people who will genuinely use them.' },
  { title: 'Earn', text: 'Earn commission on verified retail sales in your team and withdraw it to your bank.' },
];

export const DEFAULT_SITE: SiteContentData = {
  settings: {
    name: 'Our Company',
    tagline: 'Everyday products sold through trusted local franchises, with a fair way for members to earn from real retail sales.',
    logoUrl: '',
    email: 'support@example.com', phone: '+91 90000 00000', whatsapp: '', address: 'Head Office, Your City, India', hours: 'Mon to Sat, 10 am to 6 pm',
    footerAbout: 'Quality products sold through trusted local franchises.',
    footerNote: '',
    disclaimer: '',
    nav: DEFAULT_NAV,
    theme: { forest: '#123b2b', forestDeep: '#0e3325', cream: '#f7f5ee', card: '#fffdf8', sage: '#e9eee4', line: '#dce4d9', gold: '#b89153', mute: '#5d7065' },
  },
  pages: {
    home: [
      { id: 'home-hero', type: 'hero', visible: true, kicker: 'Products · Franchises · Members', title: 'Products you’ll use. A network you can trust.', text: '{{name}} sells everyday products through local franchises. Members buy what they use, share it with people who will too, and earn commission on verified retail sales.', primary: L('Explore Our Products', '/products'), secondary: enquire, noteText: 'Already a member?', noteLink: L('Sign in', '/login'), imageUrl: '' },
      { id: 'home-strip', type: 'strip', visible: true, items: [{ label: 'Real retail sales', text: 'Commission only on verified purchases' }, { label: 'Local franchises', text: 'Buy and get help close to home' }, { label: 'Clear records', text: 'Every order and payout in your portal' }, { label: 'Real support', text: 'Tickets answered by the head office' }] },
      { id: 'home-why', type: 'cards', visible: true, kicker: 'Why {{name}}', title: 'Built to be simple and fair', intro: 'Six things members, franchises and customers can count on.', columns: 3, cta: none, cards: [
        card('Products for everyday use', 'A focused range of products to try, use and repurchase, available as joining kits and individual items.'),
        card('Commission on real sales', 'Earnings come from verified retail purchases. Signing someone up does not earn anything on its own.'),
        card('Local franchises', 'Franchises stock our products, serve members in their area and are supported directly by the head office.'),
        card('Everything in your portal', 'Orders, delivery status, commissions, wallet and withdrawals are visible in one place.'),
        card('Delivery you can follow', 'See where each order stands, from placed to delivered, under Purchase History.'),
        card('Help that answers', 'Raise a ticket, attach a photo and follow the conversation with the head office until it is solved.'),
      ] },
      { id: 'home-how', type: 'steps', visible: true, kicker: 'How it works', title: 'Four steps from sign-up to your first earnings', intro: 'Becoming a member is simple, and every step is visible in your own portal.', steps: HOW },
      { id: 'home-shop', type: 'products', visible: true, kicker: 'Available now', title: 'Buy our products', intro: 'Joining kits to get started and products to repurchase. Buy them at any franchise, or with your shopping wallet once you are a member.', show: 'all', limit: 8, tabs: false, cta: L('View all products', '/products') },
      { id: 'home-members', type: 'cards', visible: true, kicker: 'In your portal', title: 'Everything a member needs', intro: '', columns: 4, cta: none, cards: [
        card('Shop & repurchase', 'Buy joining kits and repurchase products with your shopping wallet.'),
        card('Your team', 'See the people you introduced and your team level by level.'),
        card('Commissions', 'Follow what you have earned, what is pending and what is paid.'),
        card('Withdrawals', 'Add your bank details once and request a withdrawal when you are ready.'),
      ] },
      { id: 'home-plans', type: 'plans', visible: true, kicker: 'Franchise opportunity', title: 'Open a franchise near you', intro: 'Franchises serve members in their area and sell our products from their own stock. Choose the plan that fits your size: a bigger plan means a bigger discount and the ability to supply smaller franchises.', note: 'Plans, investments and discounts are set by the head office and can change. Talk to us before you commit.', cta: L('Apply for a franchise', '/contact#enquire') },
      { id: 'home-earn', type: 'split', visible: true, kicker: 'Member opportunity', title: 'Earn on real retail sales', text: 'As a member you buy products you actually use and share them with people who will too. When a purchase in your team is delivered, commission is shared up the levels. It is paid only on verified retail sales, never on recruiting alone.', bullets: ['Direct referral and team (level) commission', 'Commission credited after a short cooling-off period', 'Withdraw to your verified bank account', 'Every order, commission and payout visible in your portal'], imageUrl: '', imageSide: 'left', cta: L('See how it works', '/opportunity') },
      { id: 'home-levels', type: 'levels', visible: true, kicker: 'Commission levels', title: 'The commission levels', intro: 'These are the current rates, taken live from our commission plan.', note: 'Rates can change for future orders. Orders already placed keep the rate they were bought under.' },
      { id: 'home-gallery', type: 'gallery', visible: true, includeProducts: false, kicker: 'Photo gallery', title: 'Moments and products', intro: 'A look at our products and the community around them.', limit: 6, cta: L('View the full gallery', '/gallery') },
      { id: 'home-faq', type: 'faq', visible: true, kicker: 'Questions people ask', title: 'Good to know', items: [
        { q: 'How do I become a member?', a: 'Sign up with a sponsor code from the person who introduced you and the code of a franchise. Both are on the sign-up form.' },
        { q: 'Where can I buy the products?', a: 'At any franchise, or with your shopping wallet from your member portal. Prices on this website include taxes.' },
        { q: 'Do members earn by recruiting?', a: 'No. Commission is paid only on verified retail product sales. Signing someone up does not by itself earn anything, and earnings are not guaranteed.' },
        { q: 'How do I withdraw my earnings?', a: 'Add and verify your bank details once, then request a withdrawal from your portal. The head office reviews and pays it.' },
        { q: 'How do I open a franchise?', a: 'Choose a plan in the Franchise opportunity section and send us an enquiry. The head office will explain the investment, the stock supplied to you and how the prepaid account works.' },
        { q: 'What if I have a problem with an order?', a: 'Raise a support ticket from your portal, with photos if they help. The head office replies in the same ticket.' },
      ] },
      ENQUIRY('home-enquiry'),
      JOIN_CTA('home-join'),
    ],
    about: [
      { id: 'about-hero', type: 'pagehero', visible: true, kicker: 'Who we are', title: 'About {{name}}', text: '{{name}} brings everyday products to people through trusted local franchises, and gives members a transparent way to earn from real retail sales.', primary: none, secondary: none },
      { id: 'about-identity', type: 'strip', visible: true, items: [{ label: 'What we do', text: 'Products through local franchises' }, { label: 'How members earn', text: 'Commission on verified retail sales' }, { label: 'How we work', text: 'Clear records, honest claims' }] },
      { id: 'about-mission', type: 'cards', visible: true, kicker: 'What we stand for', title: 'Our principles', intro: '', columns: 3, cta: none, cards: [
        card('Products first', 'We want members and customers to buy products they genuinely use and come back for.'),
        card('Honest earnings', 'Commission is paid on verified retail sales only. We never promise income, because earnings depend on your own effort.'),
        card('Everything visible', 'Orders, commissions, wallet movements and payouts are recorded and visible to the people they belong to.'),
      ] },
      { id: 'about-how', type: 'steps', visible: true, kicker: 'How it works', title: 'From the head office to your door', intro: '', steps: [
        { title: 'Head office', text: 'Sets the product range, prices and commission plan, and supplies stock to franchises.' },
        { title: 'Franchises', text: 'Stock our products, serve members in their area and deliver their orders.' },
        { title: 'Members', text: 'Buy and use the products, share them and earn commission on verified retail sales.' },
        { title: 'Support', text: 'Members and franchises raise tickets and the head office answers them.' },
      ] },
      { id: 'about-text', type: 'text', visible: true, kicker: 'Our story', title: 'Tell your story here', paragraphs: ['Use this space to tell visitors who you are: when {{name}} started, why, and what you want to be known for.', 'Edit this text in Admin → Website Content → About.'] },
      { id: 'about-cta', type: 'cta', visible: true, title: 'Want to know more?', text: 'Talk to the {{name}} team about our products, membership or franchises.', primary: L('Contact us', '/contact'), secondary: L('Sign up', '/register') },
    ],
    products: [
      { id: 'prod-hero', type: 'pagehero', visible: true, kicker: 'Our products', title: 'Our Products', text: 'Joining kits to get started and products to repurchase. Prices include taxes.', primary: none, secondary: none },
      { id: 'prod-live', type: 'products', visible: true, kicker: 'Available now', title: 'Joining kits & products', intro: 'Buy them at any franchise, or with your shopping wallet once you are a member.', show: 'all', limit: 0, tabs: true, cta: none },
      { id: 'prod-how', type: 'steps', visible: true, kicker: 'How to buy', title: 'Three ways to get started', intro: '', steps: [
        { title: 'Visit a franchise', text: 'Buy at a franchise near you. Ask them for their franchise code to sign up.' },
        { title: 'Become a member', text: 'Sign up with a sponsor code and a franchise code.' },
        { title: 'Repurchase', text: 'Reorder products with your shopping wallet from your member portal.' },
      ] },
      ENQUIRY('prod-enquiry', 'Ask about a product'),
    ],
    franchise: [
      { id: 'fr-hero', type: 'pagehero', visible: true, kicker: 'Franchise opportunity', title: 'Open a {{name}} franchise', text: 'Serve members in your area, sell our products from your own stock and earn a discount on every item you stock.', primary: L('Apply for a franchise', '/contact#enquire'), secondary: none },
      { id: 'fr-plans', type: 'plans', visible: true, kicker: 'Plans', title: 'Choose the plan that fits you', intro: 'A bigger plan means a bigger discount and the ability to supply smaller franchises.', note: 'Plans, investments and discounts are set by the head office and can change. Talk to us before you commit.', cta: L('Apply for a franchise', '/contact#enquire') },
      { id: 'fr-how', type: 'steps', visible: true, kicker: 'How it works', title: 'From enquiry to your first sale', intro: '', steps: [
        { title: 'Enquire', text: 'Tell us about yourself and the area you would like to serve.' },
        { title: 'Choose a plan', text: 'The head office explains each plan, its investment and its discount.' },
        { title: 'Fund your account', text: 'Add your opening investment to your prepaid account. It is used for your stock.' },
        { title: 'Receive stock & sell', text: 'Stock is supplied to you, and you sell to members and customers from it.' },
      ] },
      { id: 'fr-benefits', type: 'cards', visible: true, kicker: 'What you get', title: 'Tools to run your franchise', intro: '', columns: 3, cta: none, cards: [
        card('A discount on every item', 'You buy stock at the retail price less your plan’s discount, and sell at retail.'),
        card('Your own panel', 'Track your stock, prepaid balance, members, orders and low-stock alerts in one place.'),
        card('Supply smaller franchises', 'Larger plans can supply and manage smaller franchises beneath them.'),
        card('Orders and delivery', 'Take counter and wallet sales and mark orders delivered.'),
        card('Head-office support', 'Raise a ticket and the head office will answer it.'),
        card('Clear records', 'Every recharge, supply and sale is recorded.'),
      ] },
      { id: 'fr-faq', type: 'faq', visible: true, kicker: 'Questions people ask', title: 'Good to know', items: [
        { q: 'What does the investment pay for?', a: 'It goes into your prepaid account and is used to buy stock from the head office for joining and repurchase products.' },
        { q: 'Can I upgrade my plan later?', a: 'Yes, talk to the head office. Upgrades are decided by the head office.' },
        { q: 'Can a franchise manage other franchises?', a: 'Larger plans can supply and manage smaller franchises. The head office manages every franchise.' },
        { q: 'Are returns guaranteed?', a: 'No. Results depend on your location, your effort and the demand for the products.' },
      ] },
      ENQUIRY('fr-enquiry', 'Apply for a franchise'),
    ],
    opportunity: [
      { id: 'opp-hero', type: 'pagehero', visible: true, kicker: 'Opportunity', title: 'How you can earn', text: 'A clear plan built on real retail sales. No hidden steps, and every figure shows up in your own portal.', primary: L('Sign up', '/register'), secondary: none },
      { id: 'opp-ways', type: 'cards', visible: true, kicker: 'Ways to earn', title: 'Three simple parts', intro: '', columns: 3, cta: none, cards: [
        card('Direct referral commission', 'Earn commission when someone you personally introduced buys products.'),
        card('Team (level) commission', 'Earn a smaller share on verified retail purchases made by your team, down through the levels below you.'),
        card('Repurchase royalty', 'Earn a small share, across up to 10 levels, when your team buys products after joining. Buy any products in any quantity: there is no fixed repurchase package and no compulsory monthly purchase.'),
      ] },
      { id: 'opp-cashback', type: 'cashback', visible: true, kicker: 'Purchase cashback', title: 'Get a little back every day', intro: 'On eligible product purchases you earn cashback each day for a limited time. It goes to your income wallet, and you do not need to buy again to keep what you have earned.', note: 'Paid only on delivered product orders, and taken back in proportion if an order is refunded. Not available on every product.', cta: L('Join and start earning', '/register') },
      { id: 'opp-levels', type: 'levels', visible: true, kicker: 'Commission levels', title: 'The commission levels', intro: 'When a purchase in your team is delivered, a percentage of its retail value is shared up the levels. These are the current rates.', note: 'Rates can change for future orders. Orders already placed keep the rate they were bought under.' },
      { id: 'opp-faq', type: 'faq', visible: true, kicker: 'Questions people ask', title: 'Good to know', items: [
        { q: 'Do I earn by recruiting people?', a: 'No. Commission is paid only on verified retail product sales. Signing someone up does not by itself earn anything.' },
        { q: 'When is commission paid?', a: 'After the product is delivered and a short cooling-off period has passed. If an order is refunded, the related commission is reversed.' },
        { q: 'How do I withdraw my earnings?', a: 'Add and verify your bank details once, then request a withdrawal from your portal. The head office reviews and pays it.' },
        { q: 'What do I need to join?', a: 'A sponsor code (from the person who introduced you) and the code of a franchise. Both are on the sign-up form.' },
        { q: 'Are earnings guaranteed?', a: 'No. Earnings vary and depend on your own effort and your team’s retail purchases.' },
      ] },
      { id: 'opp-cta', type: 'cta', visible: true, title: 'Start with a sign-up', text: 'It takes a minute. You will need a sponsor code and a franchise code.', primary: L('Sign up', '/register'), secondary: L('Sign in', '/login') },
    ],
    gallery: [
      { id: 'gal-hero', type: 'pagehero', visible: true, kicker: 'Photo Gallery', title: 'Moments and products', text: 'A look at our products and the community around them.', primary: none, secondary: none },
      { id: 'gal-grid', type: 'gallery', visible: true, includeProducts: true, kicker: '', title: '', intro: '', limit: 0, cta: none },
    ],
    contact: [
      { id: 'con-hero', type: 'pagehero', visible: true, kicker: 'Contact', title: 'Talk to us', text: 'Questions about our products, joining as a member or opening a franchise? We are happy to help.', primary: none, secondary: none },
      ENQUIRY('enquire', 'Send an enquiry'),
      { id: 'con-form', type: 'contact', visible: true, formTitle: 'Send a message', infoTitle: 'Connect with us', infoNote: 'We usually reply within one working day.' },
    ],
  },
};

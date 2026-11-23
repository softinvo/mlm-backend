/**
 * Delivery of one-time codes: SMS through APITxT and email through ZeptoMail (both plain HTTPS calls, no extra packages).
 *
 * Environment:
 *   APITXT_AUTH_KEY                                   SMS
 *   ZEPTOMAIL_URL, ZEPTOMAIL_TOKEN,
 *   ZEPTOMAIL_FROM_ADDRESS, ZEPTOMAIL_FROM_NAME       email
 *
 * Without credentials, outside production, the code is printed in the server log so you can develop locally.
 * In production a missing credential is an error: a code must never be silently dropped.
 */
import { HttpError } from '../utils/http';

export type Channel = 'SMS' | 'EMAIL';
export interface Transport { sms: (mobile: string, otp: string) => Promise<void>; email: (to: { address: string; name: string }, subject: string, html: string) => Promise<void> }

const prod = () => process.env.NODE_ENV === 'production';
/** The test runner must never reach a real SMS/email gateway, whatever credentials happen to be in the environment. */
const underTest = () => !!process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test' || process.env.OTP_DELIVERY === 'log'; // OTP_DELIVERY=log: print codes instead of sending, whatever credentials are set
const fail = (what: string): never => { throw new HttpError(502, `We could not send the ${what} just now. Please try again in a minute.`); };
const timeout = () => AbortSignal.timeout(10_000);

/** 10-digit Indian mobile -> 91XXXXXXXXXX (the format APITxT expects). */
export const smsNumber = (phone: string) => (phone.length === 10 ? `91${phone}` : phone.replace(/\D/g, ''));

const real: Transport = {
  async sms(mobile, otp) {
    const authkey = process.env.APITXT_AUTH_KEY;
    if (underTest()) { console.log(`[dev] SMS to ${mobile}: ${otp}`); return; }
    if (!authkey) {
      if (prod()) { console.error('APITXT_AUTH_KEY is not set'); fail('SMS'); }
      console.log(`[dev] SMS to ${mobile}: ${otp}`); return;
    }
    const url = new URL('https://APITxT.com/api/sendOTP');
    for (const [k, v] of Object.entries({ authkey, mobile, otp, channel: 'sms' })) url.searchParams.set(k, v);
    try {
      const r = await fetch(url, { signal: timeout() });
      if (!r.ok) { console.error('APITxT SMS error:', r.status, (await r.text()).slice(0, 300)); fail('SMS'); }
    } catch (e) { if (e instanceof HttpError) throw e; console.error('APITxT SMS error:', (e as Error).message); fail('SMS'); }
  },
  async email(to, subject, html) {
    const { ZEPTOMAIL_URL: url, ZEPTOMAIL_TOKEN: token, ZEPTOMAIL_FROM_ADDRESS: from, ZEPTOMAIL_FROM_NAME: fromName } = process.env;
    const show = () => console.log(`[dev] Email to ${to.address} (${subject}): ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
    if (underTest()) { show(); return; }
    if (!url || !token || !from) {
      if (prod()) { console.error('ZeptoMail settings are not complete'); fail('email'); }
      show(); return;
    }
    // accept the full endpoint (https://api.zeptomail.in/v1.1/email) or just the host the ZeptoMail SDK takes (api.zeptomail.in/)
    const endpoint = (/^https?:\/\//i.test(url) ? url : `https://${url}`).replace(/\/+$/, '').replace(/^(https?:\/\/[^/]+)$/i, '$1/v1.1/email');
    try {
      const r = await fetch(endpoint, {
        method: 'POST', signal: timeout(),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({ from: { address: from, name: fromName || from }, to: [{ email_address: { address: to.address, name: to.name } }], subject, htmlbody: html }),
      });
      if (!r.ok) { console.error('ZeptoMail error:', r.status, (await r.text()).slice(0, 300)); fail('email'); }
    } catch (e) { if (e instanceof HttpError) throw e; console.error('ZeptoMail error:', (e as Error).message); fail('email'); }
  },
};

/** NODE_ENV=development: every code is 123456 and nothing is sent, so you can try the flows without SMS/email. Never in production, and never inside the test runner. */
export const devFixedCode = () => (process.env.NODE_ENV === 'development' && !process.env.NODE_TEST_CONTEXT ? '123456' : null);

let transport: Transport = real;
/** For tests: swap the real SMS/email calls for fakes. Pass null to restore. */
export const setTransport = (t: Transport | null) => { transport = t ?? real; };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Sends `code` to the person on their chosen channel. */
export async function sendCode(channel: Channel, to: { name: string; email: string; phone: string }, code: string, what: string, minutes: number) {
  if (channel === 'SMS') return transport.sms(smsNumber(to.phone), code);
  const company = process.env.COMPANY_NAME || 'Our Company';
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#123b2b">
    <h2 style="margin:0 0 12px">${esc(company)}</h2>
    <p>Hello ${esc(to.name)},</p>
    <p>Your one-time code to ${esc(what)} is:</p>
    <p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:16px 0">${esc(code)}</p>
    <p>It expires in ${minutes} minutes. Never share it with anyone who asks for it unprompted. If you did not ask for this, ignore this email.</p></div>`;
  return transport.email({ address: to.email, name: to.name }, `${code} is your ${company} code`, html);
}

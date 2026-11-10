'use strict';

const Stripe = require('stripe');
// Signature verification needs no Stripe API credential and makes no API calls.
const stripe = new Stripe('signature-verification-only');
const MAX_BODY_BYTES = 512 * 1024;
const supported = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
]);

function createHandler({ secret, liveMode = true, log = console.info } = {}) {
  return async function webhook(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(405, { error: 'method_not_allowed' });
    }
    if (!secret) return reply(503, { error: 'receiver_not_configured' });
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') return reply(400, { error: 'invalid_signature' });
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) return reply(413, { error: 'payload_too_large' });
        chunks.push(bytes);
      }
    } catch {
      return reply(400, { error: 'invalid_body' });
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(Buffer.concat(chunks), signature, secret);
    } catch {
      return reply(400, { error: 'invalid_signature' });
    }
    if (event.livemode !== liveMode) return reply(400, { error: 'incorrect_mode' });
    const session = event.data?.object;
    if (!supported.has(event.type) || session?.metadata?.app !== 'arya'
        || session.metadata.purpose !== 'optional_tip') {
      return reply(200, { received: true });
    }
    let outcome = 'pending';
    if (event.type === 'checkout.session.async_payment_failed') outcome = 'failed';
    else if (session.payment_status === 'paid') outcome = 'paid';
    // No account, entitlement or fulfillment is created for a voluntary tip.
    // Duplicate deliveries are harmless; eventId allows log readers to deduplicate.
    // Never log the event body, amount, payer, address, email or payment details.
    log(JSON.stringify({ event: 'arya_tip', eventId: event.id, outcome }));
    return reply(200, { received: true });
  };
}

module.exports = createHandler({
  secret: process.env.ARYA_STRIPE_WEBHOOK_SECRET,
  liveMode: process.env.ARYA_STRIPE_LIVE_MODE !== 'false',
});
module.exports.createHandler = createHandler;

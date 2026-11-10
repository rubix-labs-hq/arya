# Arya optional-tip receiver

The website uses Stripe-hosted Payment Links. This function receives only Checkout completion, delayed success and delayed failure events. It verifies the raw body with Stripe's SDK and records an event ID and outcome for Arya tips. It never grants features, changes a project or stores payer details. Duplicate deliveries have no fulfillment side effects; deduplicate log reports by event ID.

Install and test with `npm ci --prefix services/tips` and `npm test --prefix services/tips`. The public site packager includes the bundled function and its Stripe MIT license automatically when this service is present. Install its locked dependencies before packaging the site.

Production requires `ARYA_STRIPE_WEBHOOK_SECRET` as a sensitive Vercel environment variable. It must never be put in the public site config. The receiver defaults to live events; set `ARYA_STRIPE_LIVE_MODE=false` only in a separate test deployment with its own signing secret.

Configure the Stripe endpoint at `https://editwitharya.app/api/tips/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`. Tips are identified by `metadata.app=arya` and `metadata.purpose=optional_tip`. Other merchant events are acknowledged without logging their contents. Monitor delivery failures in Stripe and function errors in Vercel.

The merchant is the owner's existing REVRNT/Pulsar Campaigns account. Payment Links disclose that merchant and identify Arya in the payment description. The owner reported no current Arya tax registrations; automatic tax is disabled. This configuration does not determine whether tax registration is required.

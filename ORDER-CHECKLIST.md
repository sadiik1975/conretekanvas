# Concrete Kanvas — Order Checklist (Stripe + Printful)

The store holds **no inventory**. Every piece is printed to order by
**Printful**: the customer pays, Printful prints and ships, the owner never
touches the product. Successful Stripe checkout webhooks automatically submit paid orders to
Printful. Printful receives the customer's shipping address and the exact
Printful sync variant for the chosen size.

## Production configuration

1. In Printful, choose **Connect via API**, create a private token, and select
   the store containing these products.
2. Add the Printful token and Stripe secret key to the deployment environment
   using the names in `.env.example`. Never expose these values in browser code.
3. In Stripe, register this webhook:
   `https://YOUR-DOMAIN.example/api/stripe/webhook`
   for `checkout.session.completed`. Put the webhook signing secret into
   `STRIPE_WEBHOOK_SECRET`.
4. Replace every `0` in each product's `printfulVariants` mapping with that
   size's Printful **Sync Variant ID**.
5. Set `PUBLIC_BASE_URL`, allowed shipping countries, currency, and the flat
   shipping amount. Keep `PRINTFUL_AUTO_CONFIRM=false` for the first test so
   Printful creates a draft rather than charging you. Then set it to `true` for
   automatic fulfillment and use live Stripe keys only after the full test.

## If automatic fulfillment fails

The payment still succeeded. Check the server logs and the `checkout_orders`
table, then manually place the order in Printful using the Stripe payment's
details. Never mark an uncertain Printful request as automatically fulfilled.

## Manual recovery when an order was not submitted

1. Open the Stripe payment. Write down, from the receipt:
   - Product name (SYNK Tee / CK Hoodie / Glitch City Tee)
   - Size the customer paid for
   - Customer's full name and shipping address
   - Customer's email
2. Open the Printful dashboard and create a new order:
   - Same product, same size — match the Stripe receipt exactly.
   - Shipping address copied character-for-character from the receipt.
3. Confirm and pay the Printful order. Save the Printful order number next
   to the Stripe payment ID (a note in Stripe or a simple list works).
4. Printful prints and ships; tracking comes from Printful. If the customer
   asks where their order is, answer from the Printful order page — never
   guess a date.

## If something is wrong

- **Wrong size ordered by the customer:** that is the customer's exchange —
  handle it per the returns policy once it is published (GAP-3).
- **Defect or misprint** (bad print, wrong item, damage): Printful covers a
  free reprint or replacement. File the claim in Printful with a photo of
  the defect, then tell the customer the replacement is coming.
- **Payment landed but no address:** email the customer from the Stripe
  receipt address before placing anything. Do not guess an address.

## Weekly, five minutes

- Scan Stripe for payments with no matching Printful order number. Any
  payment without a match is a stranded order — place it that day.
- Review any `checkout_orders` rows whose status is `failed`.

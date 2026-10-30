# Concrete Kanvas — Order Checklist (v1, manual fulfillment)

The store holds **no inventory**. Every piece is printed to order by
**Printful**: the customer pays, Printful prints and ships, the owner never
touches the product. In v1 the order step is manual — this checklist is how
no paid order ever gets stranded (spec CK-013).

## When a Stripe payment lands

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

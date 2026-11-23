"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const {
  createCheckout,
  fulfillStripeEvent,
  printfulExternalId,
  verifyStripeSignature
} = require("../commerce");
const { createSynkRepository } = require("../synk-db");

const config = {
  stripeSecretKey: "sk_test_example",
  stripeWebhookSecret: "whsec_example",
  printfulToken: "printful_example",
  printfulAutoConfirm: true,
  publicBaseUrl: "https://shop.example",
  storeCurrency: "usd",
  storeShippingCents: "600",
  storeAllowedCountries: "US,CA"
};
const products = [{
  id: "tee",
  name: "Test Tee",
  price: 35,
  sizes: ["S", "M"],
  printfulVariants: { S: 123, M: 456 },
  status: "active"
}];

test("Stripe checkout uses the selected server-side product and size", async t => {
  const originalFetch = global.fetch;
  let stripeRequest;
  global.fetch = async (url, options) => {
    stripeRequest = { url: String(url), options };
    return Response.json({ url: "https://checkout.stripe.test/session" });
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await createCheckout({ productId: "tee", size: "M" }, config, products);
  assert.equal(result.url, "https://checkout.stripe.test/session");
  assert.equal(stripeRequest.url, "https://api.stripe.com/v1/checkout/sessions");
  const body = new URLSearchParams(stripeRequest.options.body);
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), "3500");
  assert.equal(body.get("line_items[0][price_data][product_data][name]"), "Test Tee — M");
  assert.equal(body.get("metadata[printfulVariantId]"), "456");
  assert.equal(body.get("shipping_address_collection[allowed_countries][0]"), "US");
  assert.equal(body.get("shipping_address_collection[allowed_countries][1]"), "CA");
  assert.equal(body.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"), "600");
});

test("checkout rejects unmapped variants and forged or stale webhooks", async () => {
  await assert.rejects(
    createCheckout(
      { productId: "tee", size: "S" },
      config,
      [{ ...products[0], printfulVariants: { S: 0 } }]
    ),
    { status: 503 }
  );
  const raw = JSON.stringify({ type: "test" });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", config.stripeWebhookSecret)
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  assert.doesNotThrow(() => verifyStripeSignature(
    raw,
    `t=${timestamp},v1=${signature}`,
    config.stripeWebhookSecret
  ));
  assert.throws(
    () => verifyStripeSignature(raw, `t=${timestamp},v1=${"0".repeat(64)}`, config.stripeWebhookSecret),
    { status: 400 }
  );
  assert.throws(
    () => verifyStripeSignature(
      raw,
      `t=${timestamp - 301},v1=${signature}`,
      config.stripeWebhookSecret
    ),
    { status: 400 }
  );
});

test("paid Stripe event submits one Printful order and survives duplicates", async t => {
  const repository = createSynkRepository(":memory:");
  const originalFetch = global.fetch;
  const printfulBodies = [];
  global.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.printful.com/orders?confirm=true");
    printfulBodies.push(JSON.parse(options.body));
    return Response.json({ code: 200, result: { id: 9876 } });
  };
  t.after(() => {
    global.fetch = originalFetch;
    repository.close();
  });
  const session = {
    id: "cs_test_123",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 3500,
    shipping_cost: { amount_total: 600 },
    metadata: {
      productId: "tee",
      size: "M",
      printfulVariantId: "456"
    },
    shipping_details: {
      name: "Test Buyer",
      address: {
        line1: "123 Market Street",
        city: "New York",
        state: "NY",
        postal_code: "10001",
        country: "US"
      }
    },
    customer_details: {
      email: "buyer@example.com",
      phone: "+12125550123"
    }
  };
  const event = {
    id: "evt_test_123",
    type: "checkout.session.completed",
    data: { object: session }
  };
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", config.stripeWebhookSecret)
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  const signature = `t=${timestamp},v1=${digest}`;

  assert.deepEqual(await fulfillStripeEvent(raw, signature, config, repository), { received: true });
  assert.deepEqual(
    await fulfillStripeEvent(raw, signature, config, repository),
    { received: true, duplicate: true }
  );
  assert.equal(printfulBodies.length, 1);
  assert.equal(printfulBodies[0].items[0].sync_variant_id, 456);
  assert.equal(printfulBodies[0].recipient.address1, "123 Market Street");
  assert.equal(printfulBodies[0].external_id, printfulExternalId("cs_test_123"));
  assert.ok(printfulBodies[0].external_id.length <= 32);
  const order = repository.database.prepare(
    "SELECT status, printful_order_id FROM checkout_orders WHERE stripe_session_id = ?"
  ).get(session.id);
  assert.equal(order.status, "fulfilled");
  assert.equal(order.printful_order_id, "9876");
});

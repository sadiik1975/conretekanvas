"use strict";

const { createHash, createHmac, timingSafeEqual } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function productsFromDisk(filePath = join(__dirname, "products.json")) {
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(data.products)) throw new Error("products.json must contain a products array.");
  return data.products;
}

function formBody(values) {
  return new URLSearchParams(values);
}

function requireCommerceConfig(config) {
  if (!config.stripeSecretKey || !config.stripeWebhookSecret || !config.printfulToken) {
    throw new HttpError(503, "Checkout is not configured yet. Please try again soon.");
  }
}

function verifyStripeSignature(rawBody, signatureHeader, secret, now = Date.now()) {
  if (typeof signatureHeader !== "string") throw new HttpError(400, "Missing Stripe signature.");
  const parts = Object.create(null);
  for (const entry of signatureHeader.split(",")) {
    const [key, value] = entry.split("=", 2);
    if (key && value) {
      (parts[key] ||= []).push(value);
    }
  }
  const timestamp = Number(parts.t && parts.t[0]);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > 300) {
    throw new HttpError(400, "Invalid Stripe signature.");
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected);
  const valid = (parts.v1 || []).some(signature => {
    const suppliedBuffer = Buffer.from(signature);
    return suppliedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(suppliedBuffer, expectedBuffer);
  });
  if (!valid) throw new HttpError(400, "Invalid Stripe signature.");
}

function parseJson(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, "Invalid Stripe event.");
  }
}

function checkoutProduct(data, products) {
  if (
    !data ||
    typeof data.productId !== "string" ||
    typeof data.size !== "string"
  ) {
    throw new HttpError(400, "Choose a product and size.");
  }
  const product = products.find(item => item.id === data.productId && item.status !== "paused");
  if (!product || !(product.sizes || []).includes(data.size)) {
    throw new HttpError(400, "That product or size is unavailable.");
  }
  const variantId = Number(product.printfulVariants && product.printfulVariants[data.size]);
  if (!Number.isSafeInteger(variantId) || variantId <= 0) {
    throw new HttpError(503, "This size is not ready for checkout. Please choose another size.");
  }
  return { product, variantId };
}

async function stripeRequest(path, secret, body) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formBody(body),
    signal: AbortSignal.timeout(30000)
  });
  const result = await response.json();
  if (!response.ok) {
    console.error(`Stripe request failed (${response.status}):`, result.error?.message);
    throw new HttpError(502, "Checkout is temporarily unavailable. Please try again.");
  }
  return result;
}

async function createCheckout(data, config, products) {
  requireCommerceConfig(config);
  if (!config.publicBaseUrl || !/^https:\/\//.test(config.publicBaseUrl)) {
    throw new HttpError(503, "The store URL is not configured.");
  }
  const { product, variantId } = checkoutProduct(data, products);
  const currency = (config.storeCurrency || "usd").toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new HttpError(503, "The store currency is invalid.");
  const countries = String(config.storeAllowedCountries || "US")
    .split(",")
    .map(country => country.trim().toUpperCase())
    .filter(Boolean);
  if (!countries.length || countries.some(country => !/^[A-Z]{2}$/.test(country))) {
    throw new HttpError(503, "The shipping countries are invalid.");
  }
  const price = Math.round(Number(product.price) * 100);
  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new HttpError(503, "This product price is invalid.");
  }
  if (config.storeShippingCents === "") {
    throw new HttpError(503, "The store shipping price is not configured.");
  }
  const shipping = Number(config.storeShippingCents);
  if (!Number.isSafeInteger(shipping) || shipping < 0) {
    throw new HttpError(503, "The shipping price is invalid.");
  }
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  const body = {
    mode: "payment",
    success_url: `${base}/?checkout=success#shop`,
    cancel_url: `${base}/?checkout=cancelled#shop`,
    "shipping_address_collection[allowed_countries][0]": countries[0],
    "line_items[0][price_data][currency]": currency,
    "line_items[0][price_data][unit_amount]": String(price),
    "line_items[0][price_data][product_data][name]": `${product.name} — ${data.size}`,
    "line_items[0][quantity]": "1",
    "metadata[productId]": product.id,
    "metadata[size]": data.size,
    "metadata[printfulVariantId]": String(variantId)
  };
  countries.slice(1).forEach((country, index) => {
    body[`shipping_address_collection[allowed_countries][${index + 1}]`] = country;
  });
  if (shipping > 0) {
    body["shipping_options[0][shipping_rate_data][type]"] = "fixed_amount";
    body["shipping_options[0][shipping_rate_data][fixed_amount][amount]"] = String(shipping);
    body["shipping_options[0][shipping_rate_data][fixed_amount][currency]"] = currency;
    body["shipping_options[0][shipping_rate_data][display_name]"] = "Shipping";
  }
  const session = await stripeRequest("checkout/sessions", config.stripeSecretKey, body);
  if (!session.url) throw new HttpError(502, "Checkout is temporarily unavailable.");
  return { url: session.url };
}

function recipientFromSession(session) {
  const shipping = session.shipping_details;
  const address = shipping && shipping.address;
  const details = session.customer_details || {};
  const name = shipping?.name || details.name || "";
  const stateRequired = ["US", "CA", "AU"].includes(address?.country);
  if (
    !name ||
    !address?.line1 ||
    !address?.city ||
    !address?.postal_code ||
    !address?.country ||
    (stateRequired && !address.state)
  ) {
    throw new HttpError(502, "Stripe did not provide a complete shipping address.");
  }
  return {
    name,
    address1: address.line1,
    address2: address.line2 || undefined,
    city: address.city,
    state_code: address.state || "",
    country_code: address.country,
    zip: address.postal_code,
    phone: details.phone || undefined,
    email: details.email || undefined
  };
}

function printfulExternalId(stripeSessionId) {
  return `ck_${createHash("sha256").update(stripeSessionId).digest("hex").slice(0, 24)}`;
}

async function fulfillStripeEvent(rawBody, signature, config, repository) {
  requireCommerceConfig(config);
  verifyStripeSignature(rawBody, signature, config.stripeWebhookSecret);
  const event = parseJson(rawBody);
  if (event.type !== "checkout.session.completed") return { received: true };
  const session = event.data && event.data.object;
  if (!session || session.payment_status !== "paid") return { received: true };
  const variantId = Number(session.metadata && session.metadata.printfulVariantId);
  if (!Number.isSafeInteger(variantId) || variantId <= 0) {
    throw new HttpError(400, "Stripe session is missing product mapping.");
  }
  const claimed = repository.claimOrder({
    stripeEventId: event.id,
    stripeSessionId: session.id,
    productId: session.metadata.productId,
    size: session.metadata.size
  });
  if (!claimed) return { received: true, duplicate: true };
  try {
    const headers = {
      Authorization: `Bearer ${config.printfulToken}`,
      "Content-Type": "application/json"
    };
    if (config.printfulStoreId) headers["X-PF-Store-Id"] = config.printfulStoreId;
    const confirm = config.printfulAutoConfirm === true ? "true" : "false";
    const response = await fetch(`https://api.printful.com/orders?confirm=${confirm}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        external_id: printfulExternalId(session.id),
        recipient: recipientFromSession(session),
        items: [{ sync_variant_id: variantId, quantity: 1 }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    const result = await response.json();
    if (!response.ok || result.code !== 200 || !result.result?.id) {
      throw new Error(`Printful rejected order (${response.status}, ${result.code || "unknown"})`);
    }
    repository.finishOrder(session.id, {
      status: "fulfilled",
      printfulOrderId: String(result.result.id)
    });
  } catch (error) {
    repository.finishOrder(session.id, { status: "failed", error: error.message });
    console.error("Printful fulfillment needs review:", error.message);
    throw new HttpError(502, "The order payment succeeded but fulfillment needs manual review.");
  }
  return { received: true };
}

module.exports = {
  HttpError,
  createCheckout,
  fulfillStripeEvent,
  printfulExternalId,
  productsFromDisk,
  verifyStripeSignature
};

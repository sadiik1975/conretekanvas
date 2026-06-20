function scrollToDrop() {
  document.getElementById("drop").scrollIntoView({ behavior: "smooth" });
}

function buy(item) {
  alert("Checkout will connect to Stripe for: " + item);
}

function subscribe() {
  alert("Stripe subscription flow goes here ($10/month)");
}
/* Concrete Kanvas storefront — renders the shop from products.json (CK-003).
   Checkout is per-product Stripe Payment Links from the data file (CK-005).
   A product with no payment link gets the Drop 01 early-access fallback
   (User Story 1, scenario 2). No button on this page does nothing. */

(function () {
  "use strict";

  var products = [];
  var selectedSizes = {}; // productId -> size

  function buyUrl(p) {
    return (p.paymentLink || p.buy_url || "").trim();
  }

  function formatPrice(n) {
    return "$" + (Number.isInteger(n) ? n : n.toFixed(2));
  }

  function scrollToJoin() {
    var join = document.getElementById("join");
    join.scrollIntoView({ behavior: "smooth" });
    var signup = document.getElementById("drop-signup");
    setTimeout(function () { signup.focus({ preventScroll: true }); }, 600);
  }

  function showCheckoutMessage(message) {
    var status = document.getElementById("checkout-status");
    status.textContent = message;
  }

  function startCheckout(p, button) {
    var size = selectedSizes[p.id];
    if (!size) {
      showCheckoutMessage("Choose a size before checkout.");
      return;
    }
    button.disabled = true;
    button.textContent = "Opening checkout…";
    showCheckoutMessage("");
    fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: p.id, size: size })
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.message || "Checkout is unavailable.");
          return body;
        });
      })
      .then(function (body) {
        window.location.assign(body.url);
      })
      .catch(function (error) {
        showCheckoutMessage(error.message);
        button.disabled = false;
        button.textContent = "Buy — " + formatPrice(p.price);
      });
  }

  /* Build the action element for a product: real checkout link, the
     early-access fallback, or an honest Unavailable state. */
  function buildAction(p) {
    if (p.status === "paused") {
      var off = document.createElement("button");
      off.className = "btn";
      off.type = "button";
      off.disabled = true;
      off.textContent = "Unavailable";
      return off;
    }
    if (p.checkout) {
      var buy = document.createElement("button");
      buy.className = "btn btn-accent";
      buy.type = "button";
      buy.textContent = "Buy — " + formatPrice(p.price);
      buy.addEventListener("click", function () { startCheckout(p, buy); });
      return buy;
    }
    var url = buyUrl(p);
    if (url) {
      var a = document.createElement("a");
      a.className = "btn btn-accent";
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Buy — " + formatPrice(p.price);
      return a;
    }
    var b = document.createElement("button");
    b.className = "btn btn-ghost";
    b.type = "button";
    b.textContent = "Drop 01 — Join Early Access";
    b.addEventListener("click", scrollToJoin);
    return b;
  }

  function buildSizes(p, container, onPick) {
    container.innerHTML = "";
    (p.sizes || []).forEach(function (size) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "size-btn" + (selectedSizes[p.id] === size ? " is-selected" : "");
      btn.textContent = size;
      btn.setAttribute("aria-pressed", selectedSizes[p.id] === size ? "true" : "false");
      btn.addEventListener("click", function () {
        selectedSizes[p.id] = size;
        container.querySelectorAll(".size-btn").forEach(function (el) {
          var on = el.textContent === size;
          el.classList.toggle("is-selected", on);
          el.setAttribute("aria-pressed", on ? "true" : "false");
        });
        if (onPick) onPick(size);
      });
      container.appendChild(btn);
    });
  }

  function renderGrid() {
    var grid = document.getElementById("product-grid");
    grid.innerHTML = "";
    products.forEach(function (p) {
      if (!selectedSizes[p.id] && p.sizes && p.sizes.length) {
        selectedSizes[p.id] = p.sizes[Math.min(1, p.sizes.length - 1)];
      }
      var card = document.createElement("article");
      card.className = "card";

      var media = document.createElement("button");
      media.type = "button";
      media.className = "card-media";
      media.setAttribute("aria-label", "View " + p.name);
      var img = document.createElement("img");
      img.src = p.image;
      img.alt = p.name;
      media.appendChild(img);
      media.addEventListener("click", function () { openModal(p); });

      var name = document.createElement("h3");
      name.textContent = p.name;
      name.addEventListener("click", function () { openModal(p); });

      var price = document.createElement("p");
      price.className = "price";
      price.textContent = formatPrice(p.price);

      var blurb = document.createElement("p");
      blurb.className = "blurb";
      blurb.textContent = p.blurb || "";

      var sizeLabel = document.createElement("p");
      sizeLabel.className = "size-label";
      sizeLabel.textContent = "Size";

      var sizes = document.createElement("div");
      sizes.className = "sizes";
      sizes.setAttribute("role", "group");
      sizes.setAttribute("aria-label", "Choose a size for " + p.name);
      buildSizes(p, sizes);

      card.appendChild(media);
      card.appendChild(name);
      card.appendChild(price);
      card.appendChild(blurb);
      card.appendChild(sizeLabel);
      card.appendChild(sizes);
      card.appendChild(buildAction(p));
      grid.appendChild(card);
    });
  }

  /* ---------- product detail (CK-004) ---------- */
  var modal = document.getElementById("product-modal");

  function openModal(p) {
    if (!selectedSizes[p.id] && p.sizes && p.sizes.length) {
      selectedSizes[p.id] = p.sizes[Math.min(1, p.sizes.length - 1)];
    }
    document.getElementById("modal-img").src = p.image;
    document.getElementById("modal-img").alt = p.name;
    document.getElementById("modal-name").textContent = p.name;
    document.getElementById("modal-price").textContent = formatPrice(p.price);
    document.getElementById("modal-blurb").textContent = p.blurb || "";
    var sizes = document.getElementById("modal-sizes");
    buildSizes(p, sizes, function () { renderGridSelection(p); });
    var action = document.getElementById("modal-action");
    action.innerHTML = "";
    action.appendChild(buildAction(p));
    var tk = document.getElementById("modal-tiktok");
    if (p.tiktok) { tk.href = p.tiktok; tk.parentElement.style.display = ""; }
    else { tk.parentElement.style.display = "none"; }
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function renderGridSelection(p) {
    // keep card size pills in sync with modal picks
    renderGrid();
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = "";
  }

  modal.querySelectorAll("[data-close]").forEach(function (el) {
    el.addEventListener("click", closeModal);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });

  /* ---------- hero crossfade (fades only) ---------- */
  var slides = Array.prototype.slice.call(document.querySelectorAll(".hero-slide"));
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (slides.length > 1 && !reduceMotion) {
    var current = 0;
    setInterval(function () {
      slides[current].classList.remove("is-active");
      current = (current + 1) % slides.length;
      slides[current].classList.add("is-active");
    }, 5000);
  }

  /* ---------- intro splash: 5s video, skippable, once per session ---------- */
  var intro = document.getElementById("ck-intro");
  if (intro) {
    var introVideo = document.getElementById("ck-intro-video");
    var introDone = false;
    function dismissIntro() {
      if (introDone) return;
      introDone = true;
      try { sessionStorage.setItem("ckIntroSeen", "1"); } catch (e) {}
      intro.hidden = true;
      document.body.style.overflow = "";
      if (introVideo) { try { introVideo.pause(); } catch (err) {} }
    }
    var introSeen = false;
    try { introSeen = sessionStorage.getItem("ckIntroSeen") === "1"; } catch (e) {}
    if (introSeen || reduceMotion) {
      intro.hidden = true;
    } else {
      intro.hidden = false;
      document.body.style.overflow = "hidden";
      /* near the end, the video fades into the name card, then the site */
      setTimeout(function () { intro.classList.add("is-ending"); }, 3200);
      document.getElementById("ck-intro-skip").addEventListener("click", dismissIntro);
      if (introVideo) {
        introVideo.addEventListener("ended", dismissIntro);
        introVideo.addEventListener("error", dismissIntro);
        var playAttempt = introVideo.play();
        if (playAttempt && playAttempt.catch) playAttempt.catch(function () {});
      }
      setTimeout(dismissIntro, 6000); /* hard cap — a visitor is never trapped */
    }
  }

  /* ---------- fade-in on scroll ---------- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ---------- load the catalog ---------- */
  fetch("products.json")
    .then(function (res) {
      if (!res.ok) throw new Error("products.json failed to load");
      return res.json();
    })
    .then(function (data) {
      products = data.products || [];
      renderGrid();
      var checkout = new URLSearchParams(window.location.search).get("checkout");
      if (checkout === "success") {
        showCheckoutMessage("Payment received. Printful will prepare and ship your order.");
      } else if (checkout === "cancelled") {
        showCheckoutMessage("Checkout cancelled. Your order was not placed.");
      }
    })
    .catch(function () {
      document.getElementById("product-grid").innerHTML =
        '<p class="noscript-note">The collection could not load — refresh to try again.</p>';
    });
})();

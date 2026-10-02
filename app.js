// ========================================
// SkyPanel - Main JavaScript
// قدرتمندترین پنل کانفیگ
// ========================================

(function () {
  "use strict";

  // ===== تنظیمات =====
  const CONFIG = {
    particlesCount: 40,
    colors: ["#00BFFF", "#00FF88", "#FFFFFF"],
    minSize: 2,
    maxSize: 6,
    minDuration: 8,
    maxDuration: 18
  };

  // ===== ساخت ذرات شناور =====
  function createParticles() {
    const container = document.getElementById("particles");
    if (!container) return;

    for (let i = 0; i < CONFIG.particlesCount; i++) {
      const particle = document.createElement("div");
      particle.className = "particle";

      const size = Math.random() * (CONFIG.maxSize - CONFIG.minSize) + CONFIG.minSize;
      const left = Math.random() * 100;
      const duration = Math.random() * (CONFIG.maxDuration - CONFIG.minDuration) + CONFIG.minDuration;
      const delay = Math.random() * 10;
      const color = CONFIG.colors[Math.floor(Math.random() * CONFIG.colors.length)];

      particle.style.width = size + "px";
      particle.style.height = size + "px";
      particle.style.left = left + "%";
      particle.style.animationDuration = duration + "s";
      particle.style.animationDelay = delay + "s";
      particle.style.background = color;
      particle.style.boxShadow = "0 0 10px " + color + ", 0 0 20px " + color;

      container.appendChild(particle);
    }
  }

  // ===== افکت تیلت روی کارت =====
  function initTiltEffect() {
    const card = document.querySelector(".card");
    if (!card) return;
    if (window.innerWidth <= 768) return;

    card.addEventListener("mousemove", function (e) {
      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;

      card.style.transform =
        "perspective(1000px) rotateY(" + x * 8 + "deg) rotateX(" + -y * 8 + "deg)";
    });

    card.addEventListener("mouseleave", function () {
      card.style.transform = "perspective(1000px) rotateY(0) rotateX(0)";
    });
  }

  // ===== افکت هاور روی برچسب‌ها =====
  function initBadgeEffects() {
    const badges = document.querySelectorAll(".feature-badge");

    badges.forEach(function (badge) {
      badge.addEventListener("mouseenter", function () {
        badge.style.transform = "translateY(-3px) scale(1.05)";
      });

      badge.addEventListener("mouseleave", function () {
        badge.style.transform = "translateY(0) scale(1)";
      });
    });
  }

  // ===== لاگ در کنسول =====
  function logWelcome() {
    console.log(
      "%c⚡ SkyPanel %c قدرتمندترین پنل کانفیگ ",
      "background: linear-gradient(135deg, #00BFFF, #00FF88); color: #000; padding: 6px 12px; border-radius: 6px 0 0 6px; font-weight: 900;",
      "background: #000; color: #00BFFF; padding: 6px 12px; border-radius: 0 6px 6px 0; font-weight: 700;"
    );
  }

  // ===== راه‌اندازی =====
  function init() {
    createParticles();
    initTiltEffect();
    initBadgeEffects();
    logWelcome();
  }

  // ===== اجرا بعد از لود صفحه =====
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

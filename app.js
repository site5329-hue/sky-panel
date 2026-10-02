// ========================================
// SkyPanel - Main JavaScript
// قدرتمندترین پنل کانفیگ
// ========================================

console.log("SkyPanel قدرتمندترین پنل کانفیگ");

// نمایش پیام روی صفحه
document.addEventListener("DOMContentLoaded", function() {
  const msg = document.createElement("div");
  msg.textContent = "SkyPanel قدرتمندترین پنل کانفیگ";
  msg.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: linear-gradient(135deg, #00BFFF, #00FF88);
    color: #000;
    padding: 12px 24px;
    border-radius: 14px;
    font-family: 'Vazirmatn', sans-serif;
    font-weight: 700;
    font-size: 14px;
    box-shadow: 0 8px 30px rgba(0, 191, 255, 0.5);
    z-index: 9999;
    animation: slideUp 0.5s ease;
  `;
  document.body.appendChild(msg);

  // انیمیشن
  const style = document.createElement("style");
  style.textContent = `
    @keyframes slideUp {
      from { opacity: 0; transform: translateX(-50%) translateY(20px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;
  document.head.appendChild(style);
});

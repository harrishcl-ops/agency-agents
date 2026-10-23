// Deterministic "photos" drawn into <canvas data-photo="seed">.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
for (const c of document.querySelectorAll("canvas[data-photo]")) {
  const r = rng(Number(c.dataset.photo));
  const dpr = window.devicePixelRatio;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr);
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${r() * 360},70%,60%)`); grad.addColorStop(1, `hsl(${r() * 360},70%,35%)`);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 14; i++) {
    g.fillStyle = `hsla(${r() * 360},80%,${40 + r() * 40}%,0.55)`;
    g.beginPath(); g.arc(r() * w, r() * h, 10 + r() * Math.min(w, h) * 0.35, 0, Math.PI * 2); g.fill();
  }
}

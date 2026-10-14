/* Sociafy motion kit: variable fallbacks, brand theming, text fitting, shared scenes.
   Loaded by every template; each template calls MK.boot(defaults, build). */
(function () {
  const BASE = {
    brandName: "Your Brand",
    tagline: "Made for what's next",
    cta: "Learn more",
    colors: { primary: "#4f46e5", secondary: "#0ea5e9", background: "#f5f4f0", text: "#16161a", accent: "#f97316" },
    fontDisplayUrl: "", fontBodyUrl: "", logoUrl: "", logoReverseUrl: "",
    facts: [], screenshots: [], musicMood: "none", musicUrl: "", style: "soft",
    hook: "", lines: [],
  };

  // ---------- values ----------
  const str = (v, d) => (typeof v === "string" && v.trim() ? v.trim() : d);
  const arr = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).slice(0, max) : []);
  const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  const col = (v, d) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim() : d);

  function resolve(tplDefaults) {
    const hf = (window.__hyperframes && window.__hyperframes.getVariables && window.__hyperframes.getVariables()) || {};
    const raw = Object.assign({}, hf, window.__MOTION_VARS || {});
    const d = Object.assign({}, BASE, tplDefaults);
    const c = raw.colors && typeof raw.colors === "object" ? raw.colors : {};
    const facts = arr(raw.facts, 6), lines = arr(raw.lines, 8), shots = arr(raw.screenshots, 8);
    return {
      brandName: str(raw.brandName, d.brandName),
      tagline: str(raw.tagline, d.tagline),
      cta: str(raw.cta, d.cta),
      colors: {
        primary: col(c.primary, d.colors.primary), secondary: col(c.secondary, d.colors.secondary),
        background: col(c.background, d.colors.background), text: col(c.text, d.colors.text), accent: col(c.accent, d.colors.accent),
      },
      fontDisplayUrl: str(raw.fontDisplayUrl, ""), fontBodyUrl: str(raw.fontBodyUrl, ""),
      logoUrl: str(raw.logoUrl, ""), logoReverseUrl: str(raw.logoReverseUrl, ""),
      facts: facts.length ? facts : d.facts.slice(),
      screenshots: shots,
      musicMood: ["calm", "upbeat", "cinematic", "none"].includes(raw.musicMood) ? raw.musicMood : "none",
      style: raw.style === "bold" ? "bold" : "soft",
      hook: str(raw.hook, d.hook),
      lines: lines.length ? lines : (d.lines || []).slice(),
    };
  }

  // ---------- color ----------
  const rgb = (h) => { h = h.slice(1); if (h.length === 3) h = h.replace(/./g, "$&$&"); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const lum = (h) => { const [r, g, b] = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const onColor = (bg) => (contrast(bg, "#ffffff") >= contrast(bg, "#111114") ? "#ffffff" : "#111114");
  const alpha = (h, a) => { const [r, g, b] = rgb(h); return `rgba(${r},${g},${b},${a})`; };

  function theme(v) {
    const c = v.colors;
    let bg = c.background, fg = c.text;
    if (contrast(bg, fg) < 4.5) fg = onColor(bg); // unreadable pair → pick ink/white
    if (v.style === "bold" && lum(bg) > lum(fg)) [bg, fg] = [fg, bg]; // bold = dark, high contrast
    const ok = (x) => contrast(x, bg) >= 3;
    const hl = [c.primary, c.accent, c.secondary].find(ok) || fg;
    const g2 = [c.accent, c.secondary].find((x) => x !== hl && ok(x));
    const ctaBg = contrast(c.primary, bg) >= 1.5 ? c.primary : fg;
    return {
      bg, fg, hl, dark: lum(bg) < 0.2, ctaBg, ctaFg: onColor(ctaBg),
      grad: g2 ? `linear-gradient(90deg, ${hl} 0%, ${g2} 100%)` : hl,
      p: c.primary, s: c.secondary === c.primary ? c.accent : c.secondary,
      mute: alpha(fg, 0.66), line: alpha(fg, 0.12), shadow: alpha(lum(bg) < 0.2 ? "#000000" : fg, 0.45),
    };
  }

  // ---------- assets ----------
  async function loadImg(src) {
    if (!src) return null;
    const img = new Image();
    img.src = src;
    try { await img.decode(); return img.naturalWidth ? img : null; } catch (e) { return null; }
  }
  async function loadFont(family, url) {
    if (!url) return false;
    try { const f = new FontFace(family, `url("${url}")`, { weight: "100 900" }); await f.load(); document.fonts.add(f); return true; } catch (e) { return false; }
  }

  // ---------- text ----------
  // "*word*" marks a keyword. Returns spans wrapped in masks for rise animations.
  function words(el, text, opts = {}) {
    el.textContent = "";
    const marked = /\*[^*]+\*/.test(text);
    const toks = text.replace(/\*([^*]+)\*/g, (m, k) => k.split(/\s+/).map((w) => "\u0001" + w).join(" ")).split(/\s+/).filter(Boolean);
    toks.forEach((t, i) => {
      let kw = t.startsWith("\u0001");
      if (!marked && opts.autoKw && i === toks.length - 1 && toks.length > 1) kw = true;
      const w = document.createElement("span"); w.className = "w";
      const s = document.createElement("span"); s.textContent = t.replace("\u0001", "");
      if (kw) s.className = "kw";
      w.appendChild(s); el.appendChild(w);
      if (i < toks.length - 1) el.appendChild(document.createTextNode(" "));
    });
    return el.querySelectorAll(".w > span");
  }
  const plain = (t) => t.replace(/\*/g, "");
  // Shrink font until el fits its own width and maxH (px). Never grows past `max`.
  function fit(el, max, maxH, min = 20) {
    let s = max;
    el.style.fontSize = s + "px";
    while (s > min && (el.scrollWidth > el.clientWidth + 1 || el.offsetHeight > maxH)) { s *= 0.94; el.style.fontSize = s + "px"; }
    return s;
  }

  // "40% less churn" → { pre:"", n:40, dec:0, comma:false, suf:"%", label:"less churn" }
  function parseFact(f) {
    const m = f.match(/^(\S*\d\S*)\s*(.*)$/);
    if (!m) return { label: f };
    const tok = m[1], nm = tok.match(/^([^\d]*?)(\d[\d,]*(?:\.\d+)?)(.*)$/);
    if (!nm) return { label: f };
    const num = nm[2];
    return { tok, pre: nm[1], n: parseFloat(num.replace(/,/g, "")), dec: (num.split(".")[1] || "").length, comma: num.includes(","), suf: nm[3], label: m[2] };
  }
  const fmtNum = (x, f) => { const s = x.toFixed(f.dec); return f.comma ? Number(s).toLocaleString("en-US", { minimumFractionDigits: f.dec, maximumFractionDigits: f.dec }) : s; };

  const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  const el = (tag, attrs = {}, parent) => { const e = document.createElement(tag); Object.assign(e, attrs); if (parent) parent.appendChild(e); return e; };

  // ---------- boot ----------
  async function boot(tplDefaults, build) {
    const ROOT = document.getElementById("root");
    const W = +ROOT.dataset.width, H = +ROOT.dataset.height, V = H > W, DUR = +ROOT.dataset.duration;
    const v = resolve(tplDefaults), T = theme(v);
    ROOT.classList.add(V ? "v" : "h", v.style, T.dark ? "dark" : "light");
    const css = { bg: T.bg, fg: T.fg, hl: T.hl, mute: T.mute, line: T.line, shadow: T.shadow, grad: T.grad, p: T.p, s: T.s, ctaBg: T.ctaBg, ctaFg: T.ctaFg, blobO: T.dark ? 0.32 : 0.24, fd: '"MDisplay"', fb: '"MBody"' };
    const [fd, fb, logoC, logoR] = await Promise.all([
      loadFont("MDisplayX", v.fontDisplayUrl), loadFont("MBodyX", v.fontBodyUrl), loadImg(v.logoUrl), loadImg(v.logoReverseUrl),
    ]);
    if (fd) css.fd = '"MDisplayX"';
    if (fb) css.fb = '"MBodyX"';
    for (const k in css) ROOT.style.setProperty("--" + k, css[k]);
    // reverse logo on dark backgrounds; otherwise colour logo (on a white tile if the bg is dark)
    const logo = T.dark ? logoR || logoC : logoC || logoR;
    const logoTile = !!logo && T.dark && logo === logoC && !logoR;

    ROOT.insertAdjacentHTML("afterbegin", '<div id="bg" data-layout-allow-overflow><div class="blob" id="blobA" data-layout-allow-overflow></div><div class="blob" id="blobB" data-layout-allow-overflow></div><div id="veil"></div></div>');
    // load every face up front: lazily-loaded weights would make fit() measure fallback metrics
    await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
    await document.fonts.ready;

    const tl = gsap.timeline({ paused: true });
    const E = v.style === "bold" ? { in: "expo.out", d: 0.75, st: 0.05 } : { in: "expo.out", d: 0.95, st: 0.07 };
    const mk = {
      v, T, W, H, V, DUR, ROOT, tl, E, loadImg, logo, logoTile, words, plain, fit, parseFact, fmtNum, el, ARROW,
      // long lines keep a ~0.9s total stagger so the last word lands quickly
      rise: (els, at, st = E.st, d = E.d) => tl.fromTo(els, { yPercent: 118 }, { yPercent: 0, duration: d, ease: E.in, stagger: Math.min(st, 0.9 / Math.max(1, els.length)) }, at),
      sink: (els, at, st = 0.025) => tl.to(els, { yPercent: -118, duration: 0.45, ease: "power3.in", stagger: st }, at),
      show: (sel, a, b) => { tl.fromTo(sel, { opacity: 0 }, { opacity: 1, duration: 0.01 }, a); if (b != null) tl.to(sel, { opacity: 0, duration: 0.01 }, b); },
      chip, endCard,
    };
    // ambient drift, whole duration
    tl.fromTo("#blobA", { x: 0, y: 0, scale: 1 }, { x: V ? 160 : 260, y: V ? 320 : 120, scale: 1.15, duration: DUR, ease: "sine.inOut" }, 0);
    tl.fromTo("#blobB", { x: 0, y: 0, scale: 1.1 }, { x: V ? -180 : -280, y: V ? -340 : -90, scale: 0.95, duration: DUR, ease: "sine.inOut" }, 0);

    await build(mk);
    return { tl }; // wrapped: a GSAP timeline is a thenable and would never resolve

    // ---------- shared pieces ----------
    function chip(from, to) {
      const c = el("div", { id: "chip" }, ROOT);
      if (logo) {
        const host = logoTile ? el("div", { className: "tile" }, c) : c;
        el("img", { src: logo.src, alt: "" }, host);
      } else el("div", { className: "name disp", textContent: v.brandName }, c);
      tl.fromTo(c, { opacity: 0, y: -14 }, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out" }, from);
      tl.to(c, { opacity: 0, y: -10, duration: 0.4, ease: "power3.in" }, to);
    }

    function endCard(at, { tagline = true } = {}) {
      const s = el("div", { className: "scene", id: "end" }, ROOT);
      const L = el("div", { id: "endLogo" }, s);
      let logoEls;
      if (logo) {
        const host = logoTile ? el("div", { className: "tile" }, L) : L;
        el("img", { src: logo.src, alt: "" }, host);
        logoEls = null;
      } else {
        const n = el("div", { id: "endName", className: "disp" }, L);
        n.style.maxWidth = (V ? 900 : 1500) + "px"; n.style.width = n.style.maxWidth;
        logoEls = words(n, v.brandName);
        fit(n, V ? 130 : 150, 400, 40);
      }
      let tagEls = null;
      if (tagline && v.tagline) { const t = el("div", { id: "endTag", className: "disp" }, s); tagEls = words(t, v.tagline); fit(t, V ? 56 : 54, V ? 210 : 140, 26); }
      const cta = el("div", { id: "cta" }, s);
      el("span", { id: "ctaTxt", textContent: plain(v.cta) }, cta);
      cta.insertAdjacentHTML("beforeend", ARROW);
      fit(cta.firstChild, V ? 42 : 38, 136, 22);

      mk.show(s, at);
      if (logoEls) mk.rise(logoEls, at + 0.05, 0.06, 1.0);
      else tl.fromTo("#endLogo", { opacity: 0, scale: 0.86, filter: "blur(18px)" }, { opacity: 1, scale: 1, filter: "blur(0px)", duration: 1.15, ease: "expo.out" }, at + 0.05);
      if (tagEls) mk.rise(tagEls, at + 0.45, 0.045, 0.85);
      tl.fromTo(cta, { opacity: 0, y: 36, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.9, ease: "expo.out" }, at + 0.75);
      tl.to(cta, { scale: 0.965, duration: 0.14, ease: "power2.in" }, at + 1.9).to(cta, { scale: 1, duration: 0.6, ease: "back.out(2.2)" }, at + 2.04);
      tl.fromTo(s, { scale: 1.03 }, { scale: 1, duration: DUR - at, ease: "power2.out" }, at);
      return s;
    }
  }

  window.MK = { boot, parseFact, contrast };
})();

// REFERENCE helpers (from a hand-made film). Not loaded by the stub: copy what you use into
// index.html's <script>, after `const tl = gsap.timeline({ paused: true });`.
// Everything is seek-safe: tweens live on the one paused timeline, and anything drawn per
// frame (count-ups, canvas, pulses) is a pure function of time driven by the clock below.

// ---------- word-landed captions: each word blurs/rises in at its own time ----------
// CSS needed:  .w { position: relative; display: inline-block; white-space: pre; }
//              .w .gr { position: absolute; left: 0; top: 0; background: linear-gradient(90deg, var(--a), var(--b));
//                       -webkit-background-clip: text; background-clip: text; color: transparent; }
// A word lands in the gradient, then hands over to the plain ink colour.
function makeWord(text, emph) {
  const s = document.createElement("span");
  s.className = emph ? "w em" : "w";
  s.innerHTML = `<span class="d">${text}</span><span class="gr">${text}</span>`;
  return s;
}
function landWord(s, at, hand = 0.6) {
  tl.fromTo(s, { opacity: 0, y: 14, filter: "blur(10px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.38, ease: "power2.out" }, at);
  tl.fromTo(s.lastChild, { opacity: 1 }, { opacity: 0, duration: 0.5, ease: "none" }, at + hand);
  tl.fromTo(s.firstChild, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "none" }, at + hand);
}
// line(el, [[text, time, emph], ...]): words land on their times (e.g. narration word times).
function line(el, list, last = true) {
  list.forEach(([text, at, emph], i) => {
    const s = makeWord(text + (i < list.length - 1 || !last ? " " : ""), emph);
    el.appendChild(s);
    landWord(s, at);
  });
}

// ---------- scene in/out and springy element entrances ----------
function scene(id, a, b) {
  tl.fromTo("#" + id, { opacity: 0, filter: "blur(12px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "power2.out" }, a);
  if (b) tl.to("#" + id, { opacity: 0, filter: "blur(14px)", y: -16, duration: 0.45, ease: "power2.in" }, b);
}
const spring = (el, at, from = { y: 46, scale: 0.92 }) =>
  tl.fromTo(el, { opacity: 0, filter: "blur(10px)", ...from }, { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", duration: 0.7, ease: "back.out(1.6)" }, at);

// ---------- logo / icon draw-on: split one stroked SVG path into its sub-paths, draw each in turn ----------
function drawMark(svg, at, dur = 0.9) {
  const p = svg.querySelector("path"), segs = p.getAttribute("d").split("M").filter(Boolean);
  const attrs = ["stroke", "stroke-width", "stroke-linejoin"].map((a) => [a, p.getAttribute(a)]);
  p.remove();
  segs.forEach((d, i) => {
    const q = document.createElementNS("http://www.w3.org/2000/svg", "path");
    q.setAttribute("d", "M" + d); attrs.forEach(([a, v]) => q.setAttribute(a, v)); q.setAttribute("stroke-linecap", "round");
    svg.appendChild(q);
    const L = q.getTotalLength() + 1;
    q.style.strokeDasharray = L;
    tl.fromTo(q, { strokeDashoffset: L }, { strokeDashoffset: 0, duration: dur * 0.55, ease: "power2.inOut" }, at + (i / segs.length) * dur * 0.6);
  });
}

// ---------- clock: per-frame drawing as a pure function of t (count-ups, pulses, canvas) ----------
// COUNT rows: [elementId, targetNumber, startSec, endSec]; eased with a cubic out.
const COUNT = [];
function draw(t) {
  COUNT.forEach(([id, to, a, b]) => {
    const p = Math.min(1, Math.max(0, (t - a) / (b - a)));
    document.getElementById(id).textContent = Math.round(to * (1 - Math.pow(1 - p, 3))).toLocaleString("en-US");
  });
  // e.g. a live dot:  dot.style.opacity = 0.55 + 0.45 * Math.cos(t * 5.2);
  // e.g. canvas particles: clear, then place each particle from a seeded start + velocity * t (never accumulate state).
}
const clock = { _t: 0, get t() { return this._t; }, set t(v) { this._t = v; draw(v); } };
// tl.fromTo(clock, { t: 0 }, { t: DURATION, duration: DURATION, ease: "none" }, 0);

// ---------- seeded random (determinism: never use bare Math.random) ----------
function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; }

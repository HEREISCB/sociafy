#!/usr/bin/env node
// Render a Sociafy motion template.
//   node motion/render.mjs --template stat --aspect 9:16 --vars vars.json --out out.mp4 [--snapshot 2,8] [--quality standard] [--keep]
// Stages the template into a temp dir (dereferencing shared kit/fonts), pulls every
// asset URL local, bakes the variables into the page, then runs `hyperframes render`
// (and `hyperframes snapshot` for poster frames, written to <out-without-ext>-frames/).
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, extname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const HF = "hyperframes@0.8.141";
const HERE = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    template: { type: "string" }, aspect: { type: "string", default: "9:16" }, vars: { type: "string" },
    out: { type: "string" }, snapshot: { type: "string" }, quality: { type: "string", default: "standard" },
    fps: { type: "string", default: "30" }, keep: { type: "boolean", default: false },
  },
});
const TEMPLATES = ["stat", "showcase", "sting"];
if (!TEMPLATES.includes(a.template) || !["9:16", "16:9"].includes(a.aspect) || !a.out) {
  console.error("usage: node motion/render.mjs --template stat|showcase|sting --aspect 9:16|16:9 --vars vars.json --out out.mp4 [--snapshot t1,t2]");
  process.exit(2);
}

const stage = mkdtempSync(join(tmpdir(), `motion-${a.template}-`));
cpSync(join(HERE, "templates", a.template), stage, { recursive: true, dereference: true });
mkdirSync(join(stage, "assets"), { recursive: true });

const varsPath = a.vars ? resolve(a.vars) : null;
const vars = varsPath ? JSON.parse(readFileSync(varsPath, "utf8")) : {};

// Every URL becomes a staged local file so the render never touches the network.
let n = 0;
async function localize(u) {
  if (typeof u !== "string" || !u.trim() || u.startsWith("data:")) return u;
  const ext = (extname(u.split(/[?#]/)[0]) || ".bin").slice(0, 6);
  const name = `assets/a${n++}${ext}`;
  try {
    if (/^https?:\/\//.test(u)) {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      writeFileSync(join(stage, name), Buffer.from(await r.arrayBuffer()));
    } else {
      const p = resolve(varsPath ? dirname(varsPath) : process.cwd(), u.replace(/^file:\/\//, ""));
      copyFileSync(p, join(stage, name));
    }
    return name;
  } catch (e) {
    console.warn(`[motion] could not fetch ${u}: ${e.message} — falling back`);
    return "";
  }
}
// A Google Fonts css2 stylesheet URL (what lib/brand/kit.ts brandVariables emits) → the font file itself:
// display takes the heaviest face listed, body the lightest. Unresolvable → bundled fallback.
async function googleFont(u, heaviest) {
  if (typeof u !== "string" || !/^https:\/\/fonts\.googleapis\.com\/css/.test(u)) return u;
  try {
    const urls = [...(await (await fetch(u)).text()).matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
    return (heaviest ? urls.at(-1) : urls[0]) ?? "";
  } catch { return ""; }
}
vars.fontDisplayUrl = await googleFont(vars.fontDisplayUrl, true);
vars.fontBodyUrl = await googleFont(vars.fontBodyUrl, false);
for (const k of ["logoUrl", "logoReverseUrl", "fontDisplayUrl", "fontBodyUrl", "musicUrl"]) vars[k] = await localize(vars[k]);
if (Array.isArray(vars.screenshots)) vars.screenshots = (await Promise.all(vars.screenshots.slice(0, 8).map(localize))).filter(Boolean);

let html = readFileSync(join(stage, "index.html"), "utf8");
const dur = +html.match(/id="root"[^>]*data-duration="([\d.]+)"/)[1];
if (a.aspect === "16:9") {
  html = html
    .replace('content="width=1080, height=1920"', 'content="width=1920, height=1080"')
    .replace('data-width="1080" data-height="1920"', 'data-width="1920" data-height="1080"');
}
const baked = JSON.stringify(vars).replace(/</g, "\\u003c");
html = html.replace('<script src="kit.js"></script>', `<script>window.__MOTION_VARS = ${baked};</script>\n    <script src="kit.js"></script>`);
if (vars.musicUrl) {
  const fade = JSON.stringify({ version: 1, lanes: [{ target: "volume", points: [{ t: 0, v: 0 }, { t: 0.6, v: 1 }, { t: dur - 1.5, v: 1 }, { t: dur, v: 0 }] }] });
  html = html.replace(/(<div id="root"[^>]*>)/, `$1<audio id="music" src="${vars.musicUrl}" data-start="0" data-duration="${dur}" data-track-index="10" data-volume="0.5" data-automation='${fade}'></audio>`);
}
writeFileSync(join(stage, "index.html"), html);

const run = (args) => {
  const t = Date.now();
  const r = spawnSync("npx", ["--yes", HF, ...args], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stdout); throw new Error(`hyperframes ${args[0]} failed`); }
  return ((Date.now() - t) / 1000).toFixed(1);
};

try {
  const out = resolve(a.out);
  mkdirSync(dirname(out), { recursive: true });
  if (a.snapshot) {
    const dir = out.replace(/\.[^.]+$/, "") + "-frames";
    mkdirSync(dir, { recursive: true });
    const s = run(["snapshot", stage, "--at", a.snapshot, "--no-end", "-o", dir]);
    console.log(`[motion] snapshots → ${dir} (${s}s)`);
  }
  if (extname(out) === ".mp4") {
    const s = run(["render", stage, "-o", out, "--fps", a.fps, "--quality", a.quality, "--quiet"]);
    console.log(`[motion] ${a.template} ${a.aspect} ${dur}s → ${out} (rendered in ${s}s)`);
  }
} finally {
  if (a.keep) console.log(`[motion] staged project kept at ${stage}`);
  else rmSync(stage, { recursive: true, force: true });
}

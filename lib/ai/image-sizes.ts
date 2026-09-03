/**
 * Output sizes for image generation, and the social-platform presets that map
 * onto them.
 *
 * The provider does NOT take a fixed enum of sizes — that was our restriction,
 * not theirs. It accepts any `WxH` satisfying three constraints, each verified
 * against the live API rather than read off a doc page:
 *
 *   · both edges divisible by 16      — `1080x1350` is refused for this alone,
 *                                       which is why Instagram's own numbers
 *                                       never worked; `1088x1360` is the same
 *                                       4:5 shape and renders fine.
 *   · at least MIN_PIXELS             — `800x800` refused, `832x832` accepted.
 *   · aspect no wider than 3:1        — `1536x512` (exactly 3.000) accepted,
 *                                       `1584x512` (3.094) refused. This is why
 *                                       LinkedIn's 4:1 banner is not offered:
 *                                       the engine cannot draw it.
 *
 * We bound what WE accept more tightly than that, because POST /images charges
 * BEFORE it generates. Cost tracks the SHORT edge, not the pixel count — a
 * near-square render is dearer than a long one of the same area. Measured at
 * `low` quality, in provider output tokens:
 *
 *     1536x512   56      1456x768  100      1024x1536  158
 *     1536x576   70      1280x720  106      1088x1360  181
 *     864x1536  120      1536x864  120      1024x1024  196
 *                                           1248x1248  228   <- dearer, same area
 *                                           1536x1536  279
 *
 * So a pixel-count cap alone would under-charge: `1248x1248` fits inside the
 * area of `1024x1536` yet costs 44% more. Every size below is therefore either
 * individually measured at or under the 196 of a `1024x1024` square, or bounded
 * by CUSTOM_MAX_PIXELS so it cannot exceed it. priceForImage bills all of them
 * at the square tier for the same reason.
 */

/** Smallest render the engine will produce. `832x832` is the smallest square we
 *  confirmed accepted; `800x800` (640,000px) is refused. Conservative on
 *  purpose — refusing a size the provider would have taken costs a caller one
 *  clear 400, whereas accepting one it refuses costs a charge and a refund. */
export const MIN_PIXELS = 692_224;

/** Hard provider ceiling on elongation, in either orientation. Exactly 3:1 is
 *  accepted, so the comparison is `>` and not `>=`. */
export const MAX_ASPECT = 3;

/** Our ceiling for a caller-supplied custom size — the area of the 1024x1024
 *  square it is billed as. Presets may exceed it because each one has been
 *  measured individually; an arbitrary size has not.
 *  ponytail: one flat cap, because pricing has one tier. If customers start
 *  asking for large near-square renders, price by short edge and raise it. */
export const CUSTOM_MAX_PIXELS = 1_048_576;

/** The three sizes this endpoint accepted before presets existed. They keep
 *  their original prices (see priceForImage) so no working integration moves. */
export const LEGACY_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;

export type ImagePreset = keyof typeof IMAGE_PRESETS;

/**
 * Named sizes per platform. The value is what we send the provider; the label
 * is what the docs and the error messages say.
 *
 * Every entry is divisible by 16, within 3:1, and measured at or below the 196
 * output tokens of a `1024x1024`. Where a platform's published pixel size is not
 * a multiple of 16 (Instagram's 1080x1350, YouTube's 1280x720) the nearest valid
 * size with the IDENTICAL aspect ratio is used, so nothing is letterboxed.
 */
export const IMAGE_PRESETS = {
  // ---- Instagram ----
  ig_square: { size: '1024x1024', ratio: '1:1', label: 'Instagram feed (square)' },
  ig_portrait: { size: '1088x1360', ratio: '4:5', label: 'Instagram feed (portrait)' },
  ig_story: { size: '864x1536', ratio: '9:16', label: 'Instagram story / reel' },
  ig_landscape: { size: '1456x768', ratio: '1.9:1', label: 'Instagram feed (landscape)' },

  // ---- Facebook ----
  fb_square: { size: '1024x1024', ratio: '1:1', label: 'Facebook feed (square)' },
  fb_story: { size: '864x1536', ratio: '9:16', label: 'Facebook story' },
  fb_link: { size: '1456x768', ratio: '1.9:1', label: 'Facebook link post' },

  // ---- X / Twitter ----
  x_post: { size: '1536x864', ratio: '16:9', label: 'X post' },
  x_header: { size: '1536x512', ratio: '3:1', label: 'X profile header' },

  // ---- LinkedIn ----
  li_post: { size: '1456x768', ratio: '1.9:1', label: 'LinkedIn post' },
  // LinkedIn publishes 4:1 for the banner. The engine refuses anything past
  // 3:1, so this is the closest renderable shape, not an exact match — crop the
  // sides if the platform complains.
  li_banner: { size: '1536x512', ratio: '3:1', label: 'LinkedIn banner (closest to 4:1)' },

  // ---- YouTube ----
  yt_thumbnail: { size: '1280x720', ratio: '16:9', label: 'YouTube thumbnail' },

  // ---- TikTok ----
  tiktok: { size: '864x1536', ratio: '9:16', label: 'TikTok video cover' },

  // ---- Pinterest ----
  pinterest_pin: { size: '1024x1536', ratio: '2:3', label: 'Pinterest pin' },
} as const satisfies Record<string, { size: string; ratio: string; label: string }>;

export const IMAGE_PRESET_IDS = Object.keys(IMAGE_PRESETS) as [ImagePreset, ...ImagePreset[]];

/** Every value a caller may send for `size`, for the docs and the 400 message. */
export const ACCEPTED_SIZE_HINT =
  `a preset (${IMAGE_PRESET_IDS.join(', ')}) or WxH in pixels ` +
  `(both divisible by 16, at least ${MIN_PIXELS.toLocaleString()}px total, ` +
  `at most ${CUSTOM_MAX_PIXELS.toLocaleString()}px total, aspect within 3:1)`;

export type ResolvedSize = {
  /** `WxH`, exactly as the provider is given it. */
  size: string;
  width: number;
  height: number;
  /** The preset this came from, when it came from one. */
  preset?: ImagePreset;
};

function isPreset(v: string): v is ImagePreset {
  return Object.prototype.hasOwnProperty.call(IMAGE_PRESETS, v);
}

/**
 * Turn whatever the caller sent into concrete pixels, or explain why not.
 *
 * One field rather than `size` plus `preset`, deliberately: two fields need a
 * precedence rule, and a precedence rule silently spends the caller's credits on
 * a shape they did not ask for. Same reasoning as `match_frame_aspect` on
 * /videos — contradictions are rejected, never resolved.
 */
export function resolveImageSize(input: string): { ok: true; value: ResolvedSize } | { ok: false; message: string } {
  if (isPreset(input)) {
    const p = IMAGE_PRESETS[input];
    const [width, height] = p.size.split('x').map(Number);
    return { ok: true, value: { size: p.size, width, height, preset: input } };
  }

  const m = /^(\d{2,5})x(\d{2,5})$/.exec(input);
  if (!m) {
    return { ok: false, message: `Unknown size "${input}". Send ${ACCEPTED_SIZE_HINT}.` };
  }
  const width = Number(m[1]);
  const height = Number(m[2]);

  // The legacy trio bypasses the custom bounds: 1024x1536 is larger than
  // CUSTOM_MAX_PIXELS but predates it, and breaking a working integration to
  // tidy up our own rule would be the wrong trade.
  if ((LEGACY_SIZES as readonly string[]).includes(input)) {
    return { ok: true, value: { size: input, width, height } };
  }

  if (width % 16 !== 0 || height % 16 !== 0) {
    // The single most likely mistake, because every platform publishes sizes
    // that are not multiples of 16. Name a valid pair so the fix is one edit.
    //
    // The height is derived from the ROUNDED WIDTH and the original ratio, not
    // rounded on its own: rounding both independently turns Instagram's
    // 1080x1350 into 1088x1344, which is 0.81 and no longer 4:5. Suggesting a
    // subtly different shape would reintroduce exactly the letterboxing this
    // endpoint exists to avoid.
    const w16 = Math.max(16, Math.round(width / 16) * 16);
    const h16 = Math.max(16, Math.round((w16 * height) / width / 16) * 16);
    const fix = `${w16}x${h16}`;
    return {
      ok: false,
      message: `Both edges must be divisible by 16 — try "${fix}", or use a preset such as ig_portrait.`,
    };
  }

  const pixels = width * height;
  if (pixels < MIN_PIXELS) {
    return {
      ok: false,
      message: `${input} is ${pixels.toLocaleString()}px, below the ${MIN_PIXELS.toLocaleString()}px minimum this model renders.`,
    };
  }
  if (pixels > CUSTOM_MAX_PIXELS) {
    return {
      ok: false,
      message:
        `${input} is ${pixels.toLocaleString()}px, over the ${CUSTOM_MAX_PIXELS.toLocaleString()}px ceiling for a custom size. ` +
        `Larger shapes are available as presets (${IMAGE_PRESET_IDS.join(', ')}).`,
    };
  }

  const aspect = Math.max(width / height, height / width);
  if (aspect > MAX_ASPECT) {
    return {
      ok: false,
      message: `${input} is ${aspect.toFixed(2)}:1. The widest this model renders is ${MAX_ASPECT}:1.`,
    };
  }

  return { ok: true, value: { size: input, width, height } };
}

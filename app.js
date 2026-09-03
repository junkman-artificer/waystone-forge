/*
 * Waystone Forge
 * Fully client-side: OCR runs in the browser via Tesseract.js (WASM), no
 * server, no API keys, no per-run cost. See README.md for how the parsing
 * heuristic works and how to tune it.
 */

// ---------------------------------------------------------------------
// Config - tune these if OCR misses rows or misjudges clipping
// ---------------------------------------------------------------------
const CONFIG = {
  // An entry is treated as "clipped" (icon cut off) if its cluster's own
  // top/bottom sits within this fraction of a line-height from the
  // screenshot's top/bottom edge.
  EDGE_MARGIN_RATIO: 0.5,
  // Two OCR lines are merged into the same rune entry when the vertical
  // gap between them is within this fraction of a typical single line's
  // height - this is what lets a wrapped suffix ("...of\nDampening") get
  // read as one entry instead of getting cut off. Larger gaps start a new
  // entry. Tune this against real screenshots if entries merge or split
  // incorrectly - it's a ratio, so it should scale with screenshot
  // resolution reasonably well on its own, but game UI spacing varies.
  CLUSTER_GAP_RATIO: 0.6,
  // Fallback single-line-height estimate (px), used only when a
  // screenshot has too few OCR lines to measure typical line height
  // directly.
  FALLBACK_LINE_HEIGHT: 40,
  // Screenshots are upscaled by this factor before OCR - Tesseract tends
  // to read small UI text more reliably at a larger size. 2 doubles both
  // dimensions (4x the pixels), which meaningfully slows OCR down; set to
  // 1 to disable if it's not helping enough to be worth the wait.
  //
  // Tried 2 -> 2.5 -> 4 in sequence, each measured against the same known
  // 15-row deck-tag test case - both increases produced literally zero
  // improvement (same exact rows failed at all three settings), real
  // evidence resolution isn't the bottleneck for what's left. 4
  // additionally introduced a genuine, narrow downside on one specific
  // row: a Fortune name that read as garbled-but-textually-close-enough
  // to trigger a "Did you mean X?" suggestion at 2.5 instead read as a
  // more Tesseract-confident but LESS textually similar misread at 4,
  // losing that suggestion. Reverted to 2.5 given 4 cost real speed
  // (16x the original pixels) for zero tag-reading benefit and this one
  // regression. This lever now looks genuinely exhausted for the
  // remaining tag failures - not worth pushing further without a new
  // reason to expect it would help, unlike grayscale which had a clear,
  // confirmed mechanism behind it.
  OCR_UPSCALE_FACTOR: 2.5,
  // Converts the upscaled screenshot to grayscale before OCR. Tesseract's
  // text/background separation is fundamentally luminance-based, not
  // hue-based - two colors can look completely distinct to a human eye
  // while sitting at a similar brightness, which is exactly the kind of
  // mismatch that could confuse that separation step even though a
  // person would never confuse the colors visually. Targets the deck-tag
  // badge specifically, whose colored-pill background is the one thing
  // in these screenshots that isn't plain light-text-on-dark-background
  // like everywhere else. Set to false to isolate whether this step
  // specifically helped, hurt, or made no difference, the same way
  // OCR_UPSCALE_FACTOR can be toggled to isolate its own effect.
  //
  // Confirmed via a real re-test to genuinely help - deck-tag failures
  // roughly halved (6/15 down to 3/15 on the same known test rows),
  // consistent with the theory that at least some of the failures were
  // a luminance-contrast problem specific to certain badge colors.
  OCR_GRAYSCALE: true,
  // A second, targeted OCR pass tries to resolve any row that still
  // has no tag after the main whole-image pass, by cropping just its
  // predicted tag-badge region (see tagCropTop/tagCropBottom in
  // clusterAndExtract) and upscaling that small crop far more
  // aggressively than the whole image ever could without a heavy
  // global speed cost - since it's now a tiny region, a much higher
  // factor is cheap. Grayscale (confirmed helping) is applied here too.
  // This is genuinely new territory versus every whole-image
  // preprocessing tweak tried so far - a small speed cost per
  // still-unresolved row (not per screenshot), roughly proportional to
  // how many rows still need it after the main pass.
  OCR_TAG_CROP_UPSCALE_FACTOR: 8,
  // How different a pixel's color has to be from the detected
  // background reference (0-255 per-channel average difference) before
  // it counts as "part of a badge" rather than background - tuned to
  // tolerate anti-aliasing/JPEG-ish noise at a badge's soft edges
  // without either missing real badges or picking up background
  // texture/scratches as false badges.
  BADGE_COLOR_THRESHOLD: 30,
  // Minimum fraction of a pixel row that has to differ from background
  // before that whole row counts as "inside a badge" - a stray colored
  // pixel or two shouldn't flip a row, but a badge's own solid fill
  // should comfortably clear this.
  BADGE_ROW_COVERAGE_THRESHOLD: 0.3,
  // Safety cap on how many allocation attempts the recipe solver will try
  // before giving up, so a huge multi-waystone query can't hang the tab.
  SOLVER_NODE_LIMIT: 200000,
  // Thresholds for offering a "Did you mean X?" suggestion when a
  // Fortune/Omen couldn't be confidently matched. Calibrated against
  // real cases, not guessed - see the two conditions in
  // suggestAffixGuess for why both exist: a bare similarity score alone
  // isn't reliable, since two genuinely different known names can
  // coincidentally score higher against each other (0.667 for
  // "Abundant"/"Ascendant") than a real garbled match scores against its
  // correct answer (0.5 for "m-+bic"/"Mythic"). A margin-over-runner-up
  // check is what actually distinguishes them.
  SUGGEST_MIN_SCORE_HIGH: 0.75, // confident enough on its own, margin doesn't matter
  SUGGEST_MIN_SCORE_LOW: 0.4, // floor below which we won't suggest even with a good margin
  SUGGEST_MIN_MARGIN: 0.15, // required lead over the runner-up when only clearing the low floor
};

const RUNE_TYPES = ["City", "Flower", "Mask", "River", "Night", "Mud", "Song"];

// The known deck-modifier tag names seen on individual runes (shown as a
// colored badge like "+1 Rest" or "+2 Monster" - only visible via
// Runecrafting > an empty rune slot, NOT the plain My Inventory screen).
// "Mining" is unconfirmed - flagged as seen once but not verified firsthand
// as of when this was added; worth removing if it never actually turns up,
// or confirming if it does.
const TAG_NAMES = ["Event", "Rest", "Foraging", "Monster", "Wild", "Shrine", "Treasure", "Mining"];

// Matches a tag badge's "+N TagName" text - built from TAG_NAMES alone,
// so kept at module level (not scoped inside clusterAndExtract) since
// both clusterAndExtract's first pass and parseScreenshot's second,
// targeted crop-retry pass need to match against the exact same
// pattern. The "+" is optional - OCR can just as easily drop or misread
// that one character as get it right, and the number+name combination
// is already distinctive enough on its own without requiring it.
const tagRegex = new RegExp(`\\+?\\s*(\\d+)\\s*(${TAG_NAMES.join("|")})\\b`, "i");

// Small hand-drawn glyph per rune type, used since we can't reuse the
// game's own art. Single-color line icons, currentColor-tinted.
const TYPE_ICONS = {
  City: '<path d="M4 20V9l4-3 4 3v11M4 20h16M9 20v-5h2v5M13 9V5l3-2 3 2v4M13 9h6v11"/>',
  Flower: '<circle cx="12" cy="12" r="2.2"/><path d="M12 9.5C12 7 10 5 12 3c2 2 0 4 0 6.5ZM12 14.5C12 17 10 19 12 21c2-2 0-4 0-6.5ZM9.5 12C7 12 5 10 3 12c2 2 4 0 6.5 0ZM14.5 12c2.5 0 4.5-2 6.5 0-2 2-4 0-6.5 0Z"/>',
  Mask: '<path d="M4 9c0-3 3.5-5 8-5s8 2 8 5-2 8-8 8-8-5-8-8Z"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M9 14c1 1 5 1 6 0"/>',
  River: '<path d="M3 8c2-2 4 2 6 0s4 2 6 0 4 2 6 0"/><path d="M3 13c2-2 4 2 6 0s4 2 6 0 4 2 6 0"/><path d="M3 18c2-2 4 2 6 0s4 2 6 0 4 2 6 0"/>',
  Night: '<path d="M18 13.5A7 7 0 1 1 10.5 6a5.5 5.5 0 0 0 7.5 7.5Z"/>',
  Mud: '<path d="M6 18c0-5 3-9 6-9s6 4 6 9-2.5 3-6 3-6 2-6-3Z"/>',
  Song: '<path d="M9 18a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/><path d="M17 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/><path d="M11 14V5l6-1v10"/>',
};

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const state = {
  // Keyed by tier|type|prefix|suffix|tags - see itemKey(). Each value is
  // { tier, type, prefix, suffix, tags, count }, where tags is an array
  // of { name, magnitude } objects (possibly empty - a rune can
  // genuinely carry zero, one, or multiple deck-modifier tags at once,
  // confirmed via a real screenshot showing runes with 2 and 3 tags
  // each). Items with no prefix/suffix (OCR couldn't read a name, or a
  // manual adjustment with no name specified) share the "Unknown|Unknown"
  // bucket per tier+type+tags. Two runes with the same tags, just listed
  // in a different order, are still treated as the same stack - itemKey
  // sorts tags before building the key specifically so order never
  // matters for merging.
  inventory: loadInventory(),
  pendingRows: [], // rows from the most recent screenshot, awaiting confirm
  waystoneData: null, // loaded from recipes.json
  deckCompositions: null, // loaded from deck-compositions.json
};

/** Stable, order-independent serialization of a tags array (a rune's
 * tags being read/entered in a different order than another otherwise-
 * identical rune must still produce the same key, so they correctly
 * merge into one stack) - used by itemKey and nowhere else, since
 * nothing else needs this exact string shape. */
function tagsKeyPart(tags) {
  return (
    (tags || [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name) || a.magnitude - b.magnitude)
      .map((t) => `${t.name}:${t.magnitude}`)
      .join(",") || "None"
  );
}

function itemKey(tier, type, prefix, suffix, tags) {
  return `${tier}|${type}|${prefix || "Unknown"}|${suffix || "Unknown"}|${tagsKeyPart(tags)}`;
}

/**
 * Normalizes inventory data to the current { tier, type, prefix, suffix,
 * tags, count } shape. Handles the pre-prefix/suffix format, where
 * values were plain counts keyed by "tier|type" - those fold into that
 * tier+type's Unknown/Unknown/no-tags bucket. Also re-keys any entry
 * saved under an earlier shape - either no tag fields at all (from
 * before tag tracking existed), or the old singular tagName/
 * tagMagnitude pair (from before multi-tag support) - into the current
 * tags-array shape. A singular tagName/tagMagnitude pair becomes a
 * one-element tags array; missing entirely becomes an empty array. The
 * key itself always gets recomputed rather than passing an old key
 * through unchanged, so every entry stays correctly addressable and
 * merges properly with anything added later under the current scheme.
 */
function migrateInventory(raw) {
  const migrated = {};
  Object.entries(raw || {}).forEach(([key, value]) => {
    if (typeof value === "number") {
      const [tierStr, type] = key.split("|");
      const tier = parseInt(tierStr, 10);
      if (!type || Number.isNaN(tier)) return;
      const newKey = itemKey(tier, type, null, null, []);
      if (!migrated[newKey]) {
        migrated[newKey] = { tier, type, prefix: null, suffix: null, tags: [], count: 0 };
      }
      migrated[newKey].count += value;
    } else if (value && typeof value === "object" && typeof value.count === "number") {
      let tags;
      if (Array.isArray(value.tags)) {
        tags = value.tags;
      } else if (value.tagName) {
        // Old singular shape - wrap into a one-element array.
        tags = [{ name: value.tagName, magnitude: value.tagMagnitude ?? 1 }];
      } else {
        tags = [];
      }
      const newKey = itemKey(value.tier, value.type, value.prefix, value.suffix, tags);
      if (!migrated[newKey]) {
        migrated[newKey] = {
          tier: value.tier,
          type: value.type,
          prefix: value.prefix || null,
          suffix: value.suffix || null,
          tags,
          count: 0,
        };
      }
      migrated[newKey].count += value.count;
    }
  });
  return migrated;
}

function loadInventory() {
  try {
    const raw = localStorage.getItem("waystone-forge-inventory");
    return raw ? migrateInventory(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function saveInventory() {
  localStorage.setItem("waystone-forge-inventory", JSON.stringify(state.inventory));
}

/** Adds (or subtracts, for a negative delta) to a specific named item's
 * count, creating the entry if needed and removing it if it hits zero. */
/** Adds (or subtracts, for a negative delta) to a specific named item's
 * count, creating the entry if needed and removing it if it hits zero.
 * `tags` is an array of { name, magnitude } objects (can be empty). */
function addToInventory(tier, type, prefix, suffix, tags, delta) {
  const key = itemKey(tier, type, prefix, suffix, tags);
  if (!state.inventory[key]) {
    state.inventory[key] = {
      tier,
      type,
      prefix: prefix || null,
      suffix: suffix || null,
      tags: tags || [],
      count: 0,
    };
  }
  state.inventory[key].count = Math.max(0, state.inventory[key].count + delta);
  if (state.inventory[key].count === 0) delete state.inventory[key];
}

/** Sums counts across every named item sharing a tier+type - what the
 * recipe solver and the aggregate summary table both need. */
/** Sums counts across every named item sharing a tier+type, optionally
 * excluding items by their specific Fortune/Omen - null for either
 * filter means "no restriction" (matches getTierTypeTotal's behavior).
 * allowedFortunes: only count an item if its prefix is in this set, OR
 * its prefix is unknown (null) - we don't exclude what we can't identify.
 * avoidedOmens: exclude an item if its suffix is in this set; an unknown
 * suffix is never excluded for the same reason. */
function getFilteredTierTypeTotal(tier, type, allowedFortunes, avoidedOmens) {
  let total = 0;
  Object.values(state.inventory).forEach((item) => {
    if (item.tier !== tier || item.type !== type) return;
    if (allowedFortunes && item.prefix && !allowedFortunes.has(item.prefix)) return;
    if (avoidedOmens && item.suffix && avoidedOmens.has(item.suffix)) return;
    total += item.count;
  });
  return total;
}

function getTierTypeTotal(tier, type) {
  return getFilteredTierTypeTotal(tier, type, null, null);
}

/** Same filtering as getFilteredTierTypeTotal, but returns the individual
 * named stacks instead of a single summed total - needed for deciding
 * WHICH specific stack(s) to actually deduct from when building, not
 * just whether there's enough in aggregate. */
function getFilteredTierTypeCandidates(tier, type, allowedFortunes, avoidedOmens) {
  const candidates = [];
  Object.entries(state.inventory).forEach(([key, item]) => {
    if (item.tier !== tier || item.type !== type || item.count <= 0) return;
    if (allowedFortunes && item.prefix && !allowedFortunes.has(item.prefix)) return;
    if (avoidedOmens && item.suffix && avoidedOmens.has(item.suffix)) return;
    candidates.push({
      key,
      prefix: item.prefix,
      suffix: item.suffix,
      tags: item.tags,
      count: item.count,
    });
  });
  return candidates;
}

/**
 * Decides which specific named stack(s) to draw `neededCount` of a type
 * from, given the current candidate stacks:
 *  - If one or more stacks are each individually sufficient on their own,
 *    the largest is the default choice (uses up the biggest stack first,
 *    leaving smaller stacks intact for other things), and every
 *    sufficient stack is returned as an `alternatives` option - but only
 *    when there's a genuine choice (2+ of them); a single sufficient
 *    stack has nothing to compare against, so alternatives is null.
 *  - Otherwise, no single stack covers it - split greedily across
 *    stacks, largest first. This case never offers alternatives: with
 *    partial splits from multiple stacks, "pick a different option"
 *    doesn't map to a simple choice the way it does in the single-stack
 *    case, so it's left as an auto-resolved default with no override for
 *    now, matching this app's threshold for what earns a manual affordance.
 *
 * This is called fresh for each type-need independently (once per type,
 * per unit), never given memory of what a PRIOR unit in the same build
 * already chose. That's deliberate, not an oversight: a later call just
 * sees whatever's currently the biggest pile, which can genuinely be a
 * different stack than an earlier call picked, if the earlier call's own
 * deduction changed which pile is biggest. Simpler and more predictable
 * than tracking cross-unit "stickiness" for a marginal benefit.
 */
function resolveTypeAllocation(candidates, neededCount) {
  const sufficientSingle = candidates.filter((c) => c.count >= neededCount);
  if (sufficientSingle.length > 0) {
    const sorted = [...sufficientSingle].sort((a, b) => b.count - a.count);
    const chosen = sorted[0];
    return {
      allocations: [
        {
          key: chosen.key,
          prefix: chosen.prefix,
          suffix: chosen.suffix,
          tags: chosen.tags,
          count: neededCount,
        },
      ],
      alternatives: sorted.length > 1 ? sorted : null,
      insufficientBy: 0,
    };
  }

  const sorted = [...candidates].sort((a, b) => b.count - a.count);
  const allocations = [];
  let remaining = neededCount;
  for (const c of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(c.count, remaining);
    if (take > 0) {
      allocations.push({
        key: c.key,
        prefix: c.prefix,
        suffix: c.suffix,
        tags: c.tags,
        count: take,
      });
      remaining -= take;
    }
  }
  return { allocations, alternatives: null, insufficientBy: remaining };
}

// ---------------------------------------------------------------------
// OCR + row parsing
// ---------------------------------------------------------------------

/**
 * Run OCR on an image element and return candidate rune rows, each tagged
 * with its type, tier, prefix/suffix (when readable), and clipping/
 * review/duplicate signals for review.
 *
 * Parsing happens in two independent phases:
 *   1. Cluster OCR lines into entries using vertical gap alone (geometry
 *      only) - this is what correctly reassembles a name that wraps onto
 *      a second line, and stays correct even if the game adds more tag
 *      lines per entry later, since clustering doesn't care what the
 *      extra lines say.
 *   2. Extract fields (type, prefix, suffix) from each cluster's merged
 *      text by content - independent of how many lines contributed to it.
 */
async function parseScreenshot(imgEl, onProgress, affixes) {
  // Upscale onto a canvas before OCR - Tesseract generally reads small UI
  // text more accurately at a larger size. Coordinates are scaled back
  // down below, so every consumer of this function works in original
  // screenshot pixel space regardless of this internal step.
  const scale = CONFIG.OCR_UPSCALE_FACTOR;
  const naturalWidth = imgEl.naturalWidth || imgEl.width;
  const naturalHeight = imgEl.naturalHeight || imgEl.height;
  let ocrInput = imgEl;
  if (scale !== 1 || CONFIG.OCR_GRAYSCALE) {
    const canvas = document.createElement("canvas");
    canvas.width = naturalWidth * scale;
    canvas.height = naturalHeight * scale;
    const ctx = canvas.getContext("2d");
    // Tried disabling smoothing here on the theory that sharp edges
    // help OCR more than smooth interpolation - measured WORSE in
    // practice (8/15 tag-read failures vs. 6/15 with smoothing on),
    // so reverted. Likely explanation: this UI's small text is
    // probably rendered with sub-pixel anti-aliasing to begin with,
    // and nearest-neighbor-style scaling (no smoothing) blockifies
    // that detail away rather than preserving it, which apparently
    // costs Tesseract more than sharp edges gain it for text this
    // small. Left as a cautionary note against re-trying this same
    // fix without new evidence - the "sharp edges help OCR" principle
    // is real in general, but demonstrably didn't hold here.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);

    if (CONFIG.OCR_GRAYSCALE) {
      // Standard perceptually-weighted luminance formula (ITU-R BT.601:
      // 0.299R + 0.587G + 0.114B) - reflects human eyes' greater
      // sensitivity to green than red or blue, the well-established
      // way to collapse color to a single brightness value. Every
      // pixel's R/G/B channels are all set to this same computed gray
      // value; alpha is left untouched.
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = imageData.data;
      for (let i = 0; i < px.length; i += 4) {
        const gray = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        px[i] = gray;
        px[i + 1] = gray;
        px[i + 2] = gray;
      }
      ctx.putImageData(imageData, 0, 0);
    }

    ocrInput = canvas;
  }

  const { data } = await Tesseract.recognize(ocrInput, "eng", {
    logger: (m) => {
      if (onProgress && m.status === "recognizing text") {
        onProgress(Math.round(m.progress * 100));
      }
    },
  });

  const imgHeight = naturalHeight;

  const lines = (data.lines || [])
    .map((l) => ({
      text: (l.text || "").trim(),
      y0: l.bbox.y0 / scale,
      y1: l.bbox.y1 / scale,
      confidence: l.confidence,
    }))
    .filter((l) => l.text.length > 0)
    .sort((a, b) => a.y0 - b.y0);

  const rows = clusterAndExtract(lines, imgHeight, affixes);

  // First, geometric phase: for every row with a valid tag-crop region,
  // count the actual colored badge shapes present - independent of
  // whether OCR could read any text inside them. This is what resolves
  // the "genuinely zero tags" vs. "OCR just hasn't found any yet"
  // ambiguity a text-only signal can't - a rune can now carry multiple
  // tags at once (confirmed via a real screenshot showing 2 and 3 on
  // individual runes), so "found 1 text match" is no longer enough on
  // its own to know whether that row is actually complete.
  //
  // Deliberately drawn WITHOUT grayscale and at a modest (not the
  // aggressive OCR_TAG_CROP_UPSCALE_FACTOR) upscale - this crop is only
  // ever fed to countTagBadgeRows, which needs the real, distinguishing
  // badge colors intact, not Tesseract, so neither of those two
  // OCR-specific preprocessing steps apply or would help here.
  const badgeCountDebug = [];
  rows.forEach((row) => {
    if (row.tagCropTop == null || row.tagCropBottom == null) return;
    const cropTop = Math.max(0, row.tagCropTop);
    const cropBottom = Math.min(naturalHeight, row.tagCropBottom);
    const cropHeight = cropBottom - cropTop;
    if (cropHeight <= 0) return;

    const geomCanvas = document.createElement("canvas");
    const geomScale = 2; // modest - just needs to be legible to a color-band scan, not to Tesseract
    geomCanvas.width = naturalWidth * geomScale;
    geomCanvas.height = cropHeight * geomScale;
    const geomCtx = geomCanvas.getContext("2d");
    geomCtx.drawImage(imgEl, 0, cropTop, naturalWidth, cropHeight, 0, 0, geomCanvas.width, geomCanvas.height);
    const imageData = geomCtx.getImageData(0, 0, geomCanvas.width, geomCanvas.height);
    const getPixel = (x, y) => {
      const i = (y * geomCanvas.width + x) * 4;
      return [imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]];
    };
    const badges = countTagBadgeRows(getPixel, geomCanvas.width, geomCanvas.height);
    row.expectedTagCount = badges.length;
    row.missingParts = computeMissingParts(row.prefix, row.suffix, row.tags, row.expectedTagCount);
    row.needsReview = row.missingParts.length > 0;
    // A precise crop for the text-retry pass below, bounded by the
    // REAL detected badges' own edges (converted back from this scaled,
    // cropped-region coordinate space into original screenshot pixel
    // space) rather than reusing this generous, geometry-detection-only
    // region - giving Tesseract a tight, accurate area to read from
    // rather than one that may extend well past the actual badges into
    // unrelated content underneath, which risks exactly the kind of
    // garbled, concatenated-digit misread ("+72" instead of a real "+2")
    // a retry crop bleeding into adjacent text could produce. Left
    // undefined (falls back to the generous region) when zero badges
    // were detected - there's nothing real to precisely bound in that
    // case, and needsRetry below only fires when short of tags anyway.
    if (badges.length > 0) {
      const margin = typicalLineHeight * 0.3;
      row.preciseTagCropTop = cropTop + badges[0].top / geomScale - margin;
      row.preciseTagCropBottom = cropTop + badges[badges.length - 1].bottom / geomScale + margin;
    }
    badgeCountDebug.push({ rowLabel: `${row.prefix || "?"} ${row.type} of ${row.suffix || "?"}`, badgeCount: badges.length, tagsFoundByText: row.tags.length });
  });

  // Second, targeted OCR pass: for any row where fewer tags were
  // actually resolved than badges are genuinely visible, crop just its
  // predicted tag-badge region (the precise, badge-boundary-derived
  // region above when available, falling back to the original,
  // generous tagCropTop/tagCropBottom from clusterAndExtract otherwise)
  // and retry OCR on that small crop alone, upscaled far more
  // aggressively than the whole image could be without a heavy global
  // speed cost. Run sequentially (not in parallel via Promise.all) to
  // avoid multiple simultaneous Tesseract workers contending for
  // resources.
  const needsRetry = rows.filter((r) => r.tags.length < (r.expectedTagCount ?? 0) && r.tagCropTop != null);
  const cropFactor = CONFIG.OCR_TAG_CROP_UPSCALE_FACTOR;
  // Captures what the second pass actually saw/produced for every row
  // it retried, success or failure - surfaced in the debug panel so a
  // still-failing retry can actually be diagnosed (was the crop region
  // positioned wrong, or was it right but genuinely unreadable even at
  // this much higher zoom) instead of just silently trying and giving
  // up with no visibility into what happened.
  const tagRetryDebug = [];
  for (let i = 0; i < needsRetry.length; i++) {
    const row = needsRetry[i];
    if (onProgress) {
      // Second, distinct argument - callers not yet updated to use it
      // simply ignore it, so this stays backward compatible.
      onProgress(Math.round(((i + 1) / needsRetry.length) * 100), {
        phase: "tagRetry",
        current: i + 1,
        total: needsRetry.length,
      });
    }

    const rowLabel = `${row.prefix || "?"} ${row.type} of ${row.suffix || "?"}`;
    // Prefer the precise, real-badge-boundary-derived region computed
    // above over the original, generous tagCropTop/tagCropBottom - only
    // falls back to the generous region if badge detection somehow
    // found nothing (shouldn't normally happen here, since needsRetry
    // above requires expectedTagCount > 0, meaning at least one real
    // badge was detected and preciseTagCrop* should be set).
    const cropTop = Math.max(0, row.preciseTagCropTop ?? row.tagCropTop);
    const cropBottom = Math.min(naturalHeight, row.preciseTagCropBottom ?? row.tagCropBottom);
    const cropHeight = cropBottom - cropTop;
    if (cropHeight <= 0) {
      tagRetryDebug.push({ rowLabel, cropTop, cropBottom, lines: [], matched: false, skippedReason: "invalid crop height" });
      continue;
    }

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = naturalWidth * cropFactor;
    cropCanvas.height = cropHeight * cropFactor;
    const cropCtx = cropCanvas.getContext("2d");
    cropCtx.imageSmoothingEnabled = true;
    cropCtx.imageSmoothingQuality = "high";
    // Source rectangle is the narrow original-image strip; destination
    // is the whole (much larger) crop canvas - one call crops AND
    // upscales together, no intermediate full-size copy needed.
    cropCtx.drawImage(
      imgEl,
      0, cropTop, naturalWidth, cropHeight,
      0, 0, cropCanvas.width, cropCanvas.height
    );

    if (CONFIG.OCR_GRAYSCALE) {
      const imageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
      const px = imageData.data;
      for (let j = 0; j < px.length; j += 4) {
        const gray = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
        px[j] = gray;
        px[j + 1] = gray;
        px[j + 2] = gray;
      }
      cropCtx.putImageData(imageData, 0, 0);
    }

    let cropData;
    try {
      // This crop is deliberately small and known to contain at most
      // one line of text - Tesseract's default page-segmentation mode
      // assumes a full page/document, and badly over-fragments a crop
      // this size into dozens of tiny, nonsensical "lines" instead
      // (confirmed by inspecting real crop-retry debug output: 20+
      // single-character-ish fragments from one small region, even on
      // successful matches, where the real text was buried among
      // them). PSM 7 ("treat the image as a single text line") is
      // Tesseract's own documented mode for exactly this case.
      //
      // Confirmed via a real re-test to not meaningfully help - still
      // a lot of misreading on the same known-problematic rows. Left
      // in place rather than reverted, unlike the smoothing/4x-upscale
      // attempts, since this one didn't make anything measurably
      // worse either - it's a correct, well-grounded configuration for
      // what this crop actually is, it just isn't the fix for
      // whatever's still causing the remaining failures.
      const result = await Tesseract.recognize(cropCanvas, "eng", {
        tessedit_pageseg_mode: "7",
      });
      cropData = result.data;
    } catch (err) {
      // A failed retry leaves the row exactly as the first pass left
      // it (still flagged needs-review) - never worse off for trying.
      tagRetryDebug.push({ rowLabel, cropTop, cropBottom, lines: [], matched: false, skippedReason: `Tesseract error: ${err.message || err}` });
      continue;
    }

    const cropLines = cropData.lines || [];
    const cropText = cropLines.map((l) => l.text).join(" ");
    // Multiple tags can genuinely sit within one retry crop (the same
    // reason clusterAndExtract's own first pass now uses
    // findAllTagMatches too) - every match found here gets merged in,
    // not just the first. Only genuinely NEW tags are added (an exact
    // {name, magnitude} pair already present from the first pass is
    // skipped) - this crop covers the same region the first pass
    // already saw, so a repeat match is the same badge being read
    // again, not a second, distinct one.
    const newMatches = findAllTagMatches(cropText).filter(
      (m) => !row.tags.some((existing) => existing.name === m.name && existing.magnitude === m.magnitude)
    );
    row.tags = [...row.tags, ...newMatches];
    row.missingParts = computeMissingParts(row.prefix, row.suffix, row.tags, row.expectedTagCount);
    row.needsReview = row.missingParts.length > 0;
    tagRetryDebug.push({
      rowLabel,
      cropTop,
      cropBottom,
      lines: cropLines.map((l) => ({ text: l.text, confidence: l.confidence })),
      matched: newMatches.length > 0,
      newTagsFound: newMatches.length,
    });
  }

  // rawLines is returned (not just logged) so the UI can show exactly
  // what Tesseract detected directly on the page - no DevTools required.
  return { rows, rawLines: lines, tagRetryDebug, badgeCountDebug };
}

/**
 * Builds a matcher for a known list of affix names (prefixes or
 * suffixes). Handles multi-word names (e.g. "Last Rites") by treating
 * internal whitespace as flexible, and returns the canonical name (correct
 * casing/spacing from the source list) rather than whatever casing OCR
 * happened to produce. Sorted longest-first so a longer name is preferred
 * over any shorter name that happens to be a substring of it.
 */
function buildAffixMatcher(names) {
  if (!names || names.length === 0) return { regex: null, lookup: new Map() };
  const lookup = new Map(names.map((n) => [n.toLowerCase().replace(/\s+/g, " "), n]));
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const pattern = sorted
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("|");
  return { regex: new RegExp(`\\b(${pattern})\\b`, "i"), lookup };
}

function matchAffix(text, matcher) {
  if (!matcher.regex) return null;
  const m = text.match(matcher.regex);
  if (!m) return null;
  const normalized = m[1].trim().replace(/\s+/g, " ").toLowerCase();
  return matcher.lookup.get(normalized) || null;
}

/** Finds every DISTINCT known name that appears anywhere in text, not
 * just the first (matchAffix's job). Used to detect when two separate
 * runes' text has bled together into one cluster - a legitimate single
 * rune's suffix portion should never contain a second, different known
 * Omen name, since nothing else in that region of the UI matches that
 * vocabulary. Returns canonical names (correct casing from the source
 * list), deduplicated - the same name appearing twice isn't a bleed
 * signal, a second DIFFERENT name is. */
function findAllAffixMatches(text, matcher) {
  if (!matcher.regex) return [];
  const globalRegex = new RegExp(matcher.regex.source, "gi");
  const found = new Set();
  let m;
  while ((m = globalRegex.exec(text)) !== null) {
    const normalized = m[1].trim().replace(/\s+/g, " ").toLowerCase();
    const canonical = matcher.lookup.get(normalized);
    if (canonical) found.add(canonical);
  }
  return [...found];
}

/** Finds every "+N TagName" pattern in text (a rune can now carry
 * multiple tags at once - confirmed via a real screenshot showing 2 and
 * 3 tags on individual runes). Unlike findAllAffixMatches (which only
 * cares about distinct names, since two runes can't both have "the
 * same" Omen twice), this keeps every match's own magnitude and does
 * NOT deduplicate by name - two genuinely separate badges showing the
 * same category (e.g. two distinct "+1 Monster" badges) are two real
 * tags, not one. Deliberately does not cap the result at any particular
 * length here; whether a match count is plausible against what's
 * geometrically visible is countTagBadgeRows' job, not this function's -
 * this only reports what the text itself contains. */
function findAllTagMatches(text) {
  const globalRegex = new RegExp(tagRegex.source, "gi");
  const matches = [];
  let m;
  while ((m = globalRegex.exec(text)) !== null) {
    const name = TAG_NAMES.find((t) => t.toLowerCase() === m[2].toLowerCase());
    if (name) matches.push({ name, magnitude: parseInt(m[1], 10) });
  }
  return matches;
}

/** Squared Euclidean distance between two [r,g,b] colors - squared (not
 * an actual distance) since callers only ever compare against a fixed
 * threshold, never need the real magnitude, and this avoids computing
 * an unnecessary sqrt() for every pixel in a crop region. */
function colorDistanceSq(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/** Samples points along a region's left and right edges (not every
 * pixel - background should be reliably present somewhere along these
 * edges regardless of image size, and this stays cheap even on an
 * aggressively upscaled crop) to determine the background color
 * reference for badge detection. Real tag badges don't span the full
 * crop width (there's visible background margin on both sides in every
 * real screenshot seen so far), so edge sampling is deliberately more
 * robust than corner-only sampling - a badge that happens to touch one
 * exact corner point can't corrupt the whole reference the way it
 * could with only a handful of fixed sample points. Uses the median of
 * each color channel across all samples (not the mean, which a
 * minority of badge-colored samples could still skew) - simple and
 * robust without needing a full histogram over every pixel. */
function detectBackgroundColor(getPixel, width, height) {
  const sampleCount = 20;
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    const y = Math.floor((i / (sampleCount - 1)) * (height - 1));
    samples.push(getPixel(0, y));
    samples.push(getPixel(width - 1, y));
  }
  const channel = (i) => {
    const sorted = samples.map((s) => s[i]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return [channel(0), channel(1), channel(2)];
}

/**
 * Counts distinct badge-shaped color bands within a cropped tag region,
 * independent of whether OCR could read any text inside them - a badge
 * is a solid-colored pill against the app's own dark, fairly uniform
 * background, so this classifies each horizontal row as "background" or
 * "part of a badge" by color difference from a detected background
 * reference, then counts contiguous runs of badge rows. This is the
 * geometric ground truth for "how many tags should this rune have",
 * genuinely independent of Tesseract's own text recognition - a rune
 * with 3 visible badges but only 2 OCR-readable ones is unambiguously
 * "2 resolved, 1 still needs review", and a rune with correctly zero
 * badges is unambiguously "genuinely has no tags", rather than either
 * case being indistinguishable from a plain OCR miss the way relying on
 * text alone would leave it.
 *
 * `getPixel(x, y)` returns [r, g, b] for one pixel - kept as a plain
 * accessor function rather than requiring a specific ImageData shape,
 * so this same logic works against both a real browser canvas and
 * synthetic test data.
 *
 * Returns an array of { top, bottom } row ranges (in the same
 * coordinate space as the width/height passed in), one per detected
 * badge, ordered top to bottom - not just a count, since these
 * boundaries are also what a future per-badge crop-and-retry pass would
 * need, the same way the existing tag-crop-then-retry logic already
 * uses computed regions rather than just a yes/no signal.
 */
function countTagBadgeRows(getPixel, width, height) {
  const background = detectBackgroundColor(getPixel, width, height);
  const thresholdSq = CONFIG.BADGE_COLOR_THRESHOLD * CONFIG.BADGE_COLOR_THRESHOLD;

  const rowIsBadge = [];
  for (let y = 0; y < height; y++) {
    let differing = 0;
    // Sampling every 3rd column is enough to classify a row reliably
    // and meaningfully cheaper than checking every single pixel,
    // especially against an aggressively upscaled crop.
    let sampled = 0;
    for (let x = 0; x < width; x += 3) {
      sampled++;
      if (colorDistanceSq(getPixel(x, y), background) > thresholdSq) differing++;
    }
    rowIsBadge.push(sampled > 0 && differing / sampled >= CONFIG.BADGE_ROW_COVERAGE_THRESHOLD);
  }

  const badges = [];
  let runStart = null;
  for (let y = 0; y <= height; y++) {
    const isBadge = y < height && rowIsBadge[y];
    if (isBadge && runStart === null) {
      runStart = y;
    } else if (!isBadge && runStart !== null) {
      badges.push({ top: runStart, bottom: y });
      runStart = null;
    }
  }
  return badges;
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function textSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Suggests the single most likely known name for a garbled OCR fragment
 * that didn't exact-match, or null if nothing is confident enough to be
 * worth suggesting - this is a hint offered alongside the raw text, not
 * a silent substitute for it, so withholding a weak guess is always the
 * safer choice over forcing one. Compares against sliding token-windows
 * sized to each candidate's own word count, so multi-word names (e.g.
 * "Last Rites") get a fair comparison against contiguous word-pairs, not
 * just single tokens.
 *
 * See SUGGEST_MIN_SCORE_HIGH/SUGGEST_MIN_SCORE_LOW/SUGGEST_MIN_MARGIN in
 * CONFIG for why this needs two conditions rather than one plain
 * threshold.
 */
function suggestAffixGuess(scopeText, knownNames) {
  const tokens = scopeText.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || knownNames.length === 0) return null;

  const scored = knownNames.map((name) => {
    const nameWordCount = name.split(/\s+/).length;
    let best = 0;
    for (let i = 0; i + nameWordCount <= tokens.length; i++) {
      const window = tokens.slice(i, i + nameWordCount).join(" ");
      const score = textSimilarity(window.toLowerCase(), name.toLowerCase());
      if (score > best) best = score;
    }
    return { name, score: best };
  });
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1] || { score: 0 };
  const confident =
    top.score >= CONFIG.SUGGEST_MIN_SCORE_HIGH ||
    (top.score >= CONFIG.SUGGEST_MIN_SCORE_LOW && top.score - second.score >= CONFIG.SUGGEST_MIN_MARGIN);

  return confident ? top.name : null;
}

/** Shared between initial parsing and live UI corrections, so both
 * compute "what still needs review" identically. */
/**
 * `tags` is an array of { name, magnitude } objects (possibly empty).
 * `expectedTagCount`, when known, is the geometric badge count from
 * countTagBadgeRows against the real screenshot - genuinely independent
 * of whether OCR could read any given badge's text. Left null/undefined
 * when not yet known (specifically, clusterAndExtract's own first-pass
 * call, before any real pixel analysis has happened) - Tag is
 * correctly left unflagged in that case, since there's no reliable way
 * yet to tell "this rune genuinely has zero tags" from "OCR just hasn't
 * found any yet". Once expectedTagCount IS known (parseScreenshot's
 * second pass, after running the real geometric count), Tag is flagged
 * only if fewer tags were actually resolved than badges are genuinely
 * visible - so 3 visible badges with 2 read is correctly "needs
 * review", and 0 visible badges is correctly NOT flagged at all, no
 * matter what the game's actual rule about a rune always carrying at
 * least one tag turns out to be.
 */
function computeMissingParts(prefix, suffix, tags, expectedTagCount) {
  const missingParts = [];
  if (!prefix) missingParts.push("Fortune");
  if (!suffix) missingParts.push("Omen");
  const resolvedCount = (tags || []).filter((t) => t.magnitude > 0).length;
  if (expectedTagCount != null && resolvedCount < expectedTagCount) missingParts.push("Tag");
  return missingParts;
}

/**
 * Pure logic half of parseScreenshot, split out so it's testable without
 * a live OCR run: takes pre-processed OCR lines ({text, y0, y1,
 * confidence}, already sorted top to bottom), the screenshot's pixel
 * height, and optionally the known affix lists ({fortunes, omens} as
 * loaded from rune-affixes.json), and returns rune entry rows. See
 * parseScreenshot for the two-phase design (cluster by geometry, then
 * extract fields by content).
 */
function clusterAndExtract(lines, imgHeight, affixes) {
  if (lines.length === 0) return [];

  // --- Phase 1: cluster lines into entries by vertical gap --------------
  const lineHeights = lines.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
  const typicalLineHeight =
    lineHeights.length > 0
      ? lineHeights[Math.floor(lineHeights.length / 2)]
      : CONFIG.FALLBACK_LINE_HEIGHT;
  const clusterGapThreshold = typicalLineHeight * CONFIG.CLUSTER_GAP_RATIO;

  const clusters = [[lines[0]]];
  // The previous version of this check anchored to the very start of the
  // line ("^\S+\s+TYPE"), requiring exactly one leading word before the
  // type keyword. That broke on real OCR output where garbage characters
  // (stray punctuation from a border/icon, etc.) land before the actual
  // prefix word, shifting it out of position - e.g. "(& Lavish Flower
  // Rune of..." has two tokens before "Flower", not one, so the anchored
  // check silently never fired. Searching for "TYPE Rune of" anywhere in
  // the line (not anchored) is more robust to that: a wrap-continuation
  // line (just a bare suffix like "Dampening") or a tag/value line ("+1
  // Event", "10") never contains that phrase regardless of what garbage
  // precedes it, so this still can't misfire on those.
  const entryStartRegex = new RegExp(`(${RUNE_TYPES.join("|")})\\s*Rune\\s+of\\s+`, "i");

  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i].y0 - lines[i - 1].y1;
    const looksLikeNewEntryStart = entryStartRegex.test(lines[i].text);
    if (gap <= clusterGapThreshold && !looksLikeNewEntryStart) {
      clusters[clusters.length - 1].push(lines[i]);
    } else {
      clusters.push([lines[i]]);
    }
  }

  // --- Phase 2: extract fields from each cluster's merged text -----------
  const typeRegex = new RegExp(`\\b(${RUNE_TYPES.join("|")})\\b`, "i");
  const tierRegex = /Tier\s*(\d+)/i;
  // Prefix/suffix are matched against the known Fortune/Omen lists from
  // rune-affixes.json rather than guessed generically. This is a
  // maintained reference list, not a closed assumption baked into the
  // code - see README for how to add new ones as the game introduces
  // them. Matching against known names (rather than "whatever word comes
  // next") is also what correctly handles a multi-word name like "Last
  // Rites", which a generic single-token guess would have truncated.
  const fortuneNames = affixes?.fortunes?.map((f) => f.name) || [];
  const omenNames = affixes?.omens?.map((o) => o.name) || [];
  const prefixMatcher = buildAffixMatcher(fortuneNames);
  const suffixMatcher = buildAffixMatcher(omenNames);
  // tagRegex now lives at module level (see its definition near
  // TAG_NAMES) - shared with parseScreenshot's second-pass crop retry.

  const tierHeaders = []; // { tier, top, bottom }
  const entries = [];

  clusters.forEach((cluster) => {
    const blob = cluster
      .map((l) => l.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const top = cluster[0].y0;
    const bottom = cluster[cluster.length - 1].y1;
    const midY = (top + bottom) / 2;

    const tierMatch = blob.match(tierRegex);
    if (tierMatch) {
      tierHeaders.push({ tier: parseInt(tierMatch[1], 10), top, bottom });
    }

    const typeMatch = blob.match(typeRegex);
    if (!typeMatch) return; // header-only, or unrecognized noise - not an entry

    const type = RUNE_TYPES.find((t) => t.toLowerCase() === typeMatch[1].toLowerCase());

    // Prefix always precedes the type word, suffix always follows it (per
    // "{prefix} {type} Rune of {suffix}") - splitting the search there
    // means we don't need "Rune of" itself to be legible to find a match.
    const beforeType = blob.slice(0, typeMatch.index);
    const afterType = blob.slice(typeMatch.index + typeMatch[0].length);
    const prefix = matchAffix(beforeType, prefixMatcher);
    const suffix = matchAffix(afterType, suffixMatcher);
    // Only bother guessing for whichever field genuinely failed to
    // match - a resolved field never needs a suggestion.
    const suggestedPrefix = prefix ? null : suggestAffixGuess(beforeType, fortuneNames);
    const suggestedSuffix = suffix ? null : suggestAffixGuess(afterType, omenNames);

    // Two independent, direct signals that this cluster's own text
    // genuinely bled together from two separate runes (not just a
    // legitimately-wrapped name), rather than something a crop/upscale
    // fix could ever help with, since the corruption is in what
    // Tesseract already read, not in how well it could read it:
    //
    // (a) The blob matched BOTH a tier-header pattern and a rune-name
    // pattern together - the in-game floating tier label's own text
    // literally fused with this entry's in one OCR-detected line.
    //
    // (b) afterType (everything past the type word, where only this
    // one rune's own suffix should ever legitimately appear) contains
    // a SECOND, different known Omen name beyond the one already
    // resolved - nothing else in that region of the UI matches that
    // vocabulary, so a second one appearing means a neighboring rune's
    // name bled into this cluster.
    const blobHasTierMatch = tierMatch != null;
    const afterTypeSuffixNames = findAllAffixMatches(afterType, suffixMatcher);
    const hasBleedSuffix = afterTypeSuffixNames.length > 1;
    const textuallyContaminated = blobHasTierMatch || hasBleedSuffix;

    // The tag badges sit visually below the name, but the whole cluster
    // is searched (not just afterType) rather than assuming OCR line
    // order always puts them strictly after the suffix - the "+N
    // TagName" pattern is distinctive enough that searching the full
    // blob doesn't risk a false match against unrelated text elsewhere
    // in the entry. A rune can carry multiple tags at once (confirmed
    // via a real screenshot showing 2 and 3 on individual runes), so
    // every match in the blob is kept, not just the first.
    const tags = findAllTagMatches(blob);

    // Bounding box of "everything below the rune's own name" within this
    // cluster, in original screenshot pixel space - used by the second,
    // targeted OCR pass below for whichever rows fail to resolve a tag
    // on this first, whole-image pass. Found by locating the last line
    // in the cluster whose text contains the resolved suffix word (the
    // last part of the actual rune name) - everything below that line's
    // bottom edge is where the tag badge (and price/coin junk) lives.
    // Falls back to a typicalLineHeight-sized band right below whatever
    // WAS detected (even a single-line cluster) rather than leaving no
    // region at all - the tag badge sits at a geometrically predictable
    // position regardless of whether Tesseract's first pass happened to
    // detect any text there, so this covers "detected but misread" and
    // "never detected at all" cases alike.
    //
    // A small negative top margin and a taller bottom margin were added
    // after real crop-retry debug output showed the tight version was
    // clipping the actual badge: one case's crop top landed exactly
    // inside a line Tesseract's first pass had already (imprecisely)
    // bounded, likely cutting off the tops of the retry's own glyphs
    // before it even ran; another case's narrow fallback band happened
    // to land almost exactly in the gap between two unrelated UI
    // elements, with no guarantee the actual badge was fully inside
    // that narrow window rather than partially outside it. OCR line
    // boxes aren't pixel-perfect, so a small buffer on both edges is
    // cheap insurance against re-clipping the same way twice.
    let tagCropTop = null;
    if (suffix) {
      const suffixLower = suffix.toLowerCase();
      for (let i = cluster.length - 1; i >= 0; i--) {
        if (cluster[i].text.toLowerCase().includes(suffixLower)) {
          tagCropTop = cluster[i].y1;
          break;
        }
      }
    }
    // Whether the fallback path below actually got used - distinct from
    // just "suffix is null", since suffix could still be null even if
    // this loop found a line (an unresolved name against known
    // vocabulary, but the line itself was detected). This flag is
    // specifically about whether cluster genuinely had a line
    // containing the resolved suffix text.
    const usedFallbackTop = tagCropTop == null;
    if (usedFallbackTop) {
      tagCropTop = cluster[cluster.length - 1].y1;
    }
    tagCropTop -= typicalLineHeight * 0.3;
    // Deliberately generous now, in both the normal and fallback cases -
    // a rune can carry several tags at once (confirmed via a real
    // screenshot showing 2-3 stacked badges), each taking roughly its
    // own line's worth of vertical space, so a band sized for "at most
    // one tag" (the old 2.2x/3.5x here) genuinely wasn't tall enough -
    // confirmed directly via a real "show rune" preview cutting off
    // right after the first badge, before ever reaching the second or
    // third. This region is ONLY used for the geometric badge-count
    // phase (countTagBadgeRows) below, which just needs every real
    // badge to fit somewhere inside it - overshooting into extra
    // background/unrelated content underneath is harmless for pure
    // color-band counting, unlike it would be for OCR text accuracy.
    // The actual text-retry crop, sized precisely to the real detected
    // badges rather than this generous guess, is computed separately
    // once those badges are known (see parseScreenshot).
    const bandHeight = typicalLineHeight * 7;
    const tagCropBottom = tagCropTop + bandHeight;

    const confidence = cluster.reduce((sum, l) => sum + l.confidence, 0) / cluster.length;
    // What actually needs a human's attention now is whether the fields
    // that matter resolved cleanly against known vocabulary - not
    // Tesseract's raw per-line confidence, which gets dragged down by
    // junk text (a tag chip, a coin value) that never mattered in the
    // first place and gets discarded regardless. Type is guaranteed
    // present here (the entry wouldn't exist otherwise); prefix/suffix
    // are the ones that can genuinely come back unmatched. Tag
    // completeness is deliberately NOT judged yet at this stage (see
    // computeMissingParts) - passing null here, not tags.length - since
    // the real, geometric badge count isn't known until parseScreenshot's
    // second pass runs against actual pixels.
    const missingParts = computeMissingParts(prefix, suffix, tags, null);

    entries.push({
      type,
      prefix,
      suffix,
      tags,
      tagCropTop,
      tagCropBottom,
      suggestedPrefix,
      suggestedSuffix,
      blob,
      top,
      bottom,
      midY,
      confidence,
      missingParts,
      textuallyContaminated,
      inlineTier: tierMatch ? parseInt(tierMatch[1], 10) : null,
    });
  });

  tierHeaders.sort((a, b) => a.top - b.top);
  const margin = typicalLineHeight * CONFIG.EDGE_MARGIN_RATIO;
  // Small buffer added to each tier header's own range before checking
  // overlap against an entry - OCR line boundaries aren't pixel-perfect
  // (same reasoning as the tag-crop margin above), so a header that
  // sits just barely adjacent to an entry, not strictly overlapping by
  // the raw numbers, still gets treated as contamination risk rather
  // than assuming a clean boundary that might not really be there.
  const tierOverlapBuffer = typicalLineHeight * 0.5;

  const rows = entries.map((e, idx) => {
    let tier = e.inlineTier;
    if (tier == null) {
      tier = 1;
      for (const h of tierHeaders) {
        if (h.top < e.top) tier = h.tier;
        else break;
      }
    }
    // Clipped if this entry's own text extent touches the screenshot's
    // top/bottom edge - more precise than an estimated margin, since we
    // now know each entry's real bounding box rather than one anchor line.
    const clipped = e.top < margin || e.bottom > imgHeight - margin;
    // Geometric contamination: this entry's own vertical range overlaps
    // a separately-detected tier header's range, even when their text
    // never literally merged into one blob (e.tierHeaders was already
    // checked for that, textuallyContaminated) - the in-game floating
    // tier label can visually obscure/degrade whatever's directly
    // behind or adjacent to it without its own text necessarily
    // bleeding into the same OCR line, so this catches that separately.
    const tierLabelOverlap = tierHeaders.some(
      (h) => e.top < h.bottom + tierOverlapBuffer && e.bottom > h.top - tierOverlapBuffer
    );
    const contaminated = e.textuallyContaminated || tierLabelOverlap;
    return {
      id: `${Date.now()}-${idx}`,
      type: e.type,
      tier,
      prefix: e.prefix,
      suffix: e.suffix,
      tags: e.tags,
      // top: the entry's own genuine top boundary (covers the rune
      // name/icon, not just the tag-badge area tagCropTop starts at) -
      // exposed specifically for the "show crop" preview, which needs
      // to crop from here to show the name and tag together.
      top: e.top,
      tagCropTop: e.tagCropTop,
      tagCropBottom: e.tagCropBottom,
      suggestedPrefix: e.suggestedPrefix,
      suggestedSuffix: e.suggestedSuffix,
      rawText: e.blob,
      confidence: e.confidence,
      needsReview: e.missingParts.length > 0,
      missingParts: e.missingParts,
      clipped,
      contaminated,
      included: !clipped && !contaminated,
    };
  });

  return rows;
}

// ---------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------

/**
 * Flag rows as duplicates when their type, tier, prefix, and suffix all
 * match exactly. Now that those fields are matched against known
 * vocabulary (and correctable via dropdowns) rather than being raw OCR
 * text, comparing the resolved fields directly is more reliable than
 * fuzzy-matching the raw text - which included tag/value noise that
 * could differ between two reads of the very same rune, and could also
 * coincidentally align between two genuinely different ones.
 *
 * A row with an unresolved (null) prefix or suffix is left out of
 * matching entirely - null means "unknown", not "matches anything", so
 * two rows that both still need manual correction are never flagged as
 * duplicates of each other on that basis alone. Mutates each row's
 * `duplicate` flag and `duplicateGroup` id in place.
 */
function flagDuplicates(rows) {
  rows.forEach((r) => {
    r.duplicate = false;
    r.duplicateGroup = null;
  });

  const buckets = {};
  rows.forEach((r) => {
    // Same "exclude unresolved fields from matching" rationale as
    // before - two rows both still missing a tag could be genuinely
    // different runes that each just failed to read, not actual
    // duplicates, so they're excluded rather than risk a false
    // positive. missingParts.includes("Tag") is the correct check now
    // (not a plain array-length/null check) - it's already the
    // definitive "tag resolution is incomplete" signal, correctly
    // accounting for the real, geometric badge count once the second
    // pass has run, rather than assuming any particular tag count.
    if (!r.prefix || !r.suffix || r.missingParts.includes("Tag")) return;
    const key = `${r.tier}|${r.type}|${r.prefix}|${r.suffix}|${tagsKeyPart(r.tags)}`;
    (buckets[key] = buckets[key] || []).push(r);
  });

  let nextGroupId = 1;
  Object.values(buckets).forEach((bucket) => {
    if (bucket.length > 1) {
      const groupId = nextGroupId++;
      bucket.forEach((r) => {
        r.duplicate = true;
        r.duplicateGroup = groupId;
      });
    }
  });
}

/**
 * Reorders rows so members of the same duplicate cluster sit next to each
 * other (at the position of the cluster's first occurrence), so they can
 * be compared and deconflicted at a glance. Everything not in a cluster
 * keeps its original relative order. Call after flagDuplicates.
 */
function sortForDuplicateReview(rows) {
  const origIndex = new Map(rows.map((r, i) => [r, i]));
  const firstIndexByGroup = new Map();
  rows.forEach((r, i) => {
    if (r.duplicateGroup != null && !firstIndexByGroup.has(r.duplicateGroup)) {
      firstIndexByGroup.set(r.duplicateGroup, i);
    }
  });
  return [...rows].sort((a, b) => {
    const aKey = a.duplicateGroup != null ? firstIndexByGroup.get(a.duplicateGroup) : origIndex.get(a);
    const bKey = b.duplicateGroup != null ? firstIndexByGroup.get(b.duplicateGroup) : origIndex.get(b);
    return aKey !== bKey ? aKey - bKey : origIndex.get(a) - origIndex.get(b);
  });
}

// ---------------------------------------------------------------------
// Recipe solver
// ---------------------------------------------------------------------

/** Expand a recipe's slots (which may contain wildcards) into every
 * concrete requirement, e.g. [["City"],["Mask","Mud"]] ->
 * [{City:1,Mask:1}, {City:1,Mud:1}]. */
function expandRecipeOptions(slots) {
  let combos = [{}];
  for (const slot of slots) {
    const next = [];
    for (const combo of combos) {
      for (const type of slot) {
        const copy = { ...combo };
        copy[type] = (copy[type] || 0) + 1;
        next.push(copy);
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * For quick single-waystone checks (live UI feedback, not the full joint
 * solve across multiple waystones) - finds the first recipe variant and
 * wildcard resolution for this waystone whose per-unit requirement, times
 * `quantity`, still fits within `inventory`. Returns that per-unit
 * requirement map, or null if no variant/resolution fits even once.
 */
/**
 * Finds the recipe variant/wildcard resolution that lets you build the
 * MOST copies of this waystone from `inventory`, not just any one that
 * fits - so the suggested max is the best achievable, not whatever
 * happens to be listed first. Always returns an object (maxQuantity: 0
 * if nothing can be built at all, rather than null) so callers don't
 * need a separate null-check.
 */
function bestBuildableOption(waystone, inventory) {
  let best = { requirement: null, maxQuantity: 0 };
  waystone.recipes.forEach((recipe) => {
    expandRecipeOptions(recipe.slots).forEach((req) => {
      const counts = Object.entries(req).map(
        ([type, need]) => Math.floor((inventory[type] || 0) / need)
      );
      const maxQty = counts.length > 0 ? Math.min(...counts) : 0;
      if (maxQty > best.maxQuantity) {
        best = { requirement: req, maxQuantity: maxQty };
      }
    });
  });
  return best;
}

/** A stable string key for a requirement object ({type: count, ...}),
 * independent of key insertion order - used to detect when two
 * requirements (from different recipe variants, or different wildcard
 * picks within the same variant) are actually the identical
 * combination, and to compare one requirement against another. */
function requirementSignature(req) {
  return Object.entries(req)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, n]) => `${t}:${n}`)
    .join(",");
}

/** Computes the actual resulting deck composition for one built (or
 * just-selected) unit - the waystone's fixed baseline card counts, plus
 * each specific rune actually used contributing its own tag's magnitude
 * on top, confirmed additive (a rune with "+1 Monster" adds 1 to that
 * category) and confirmed to stack when multiple runes share a tag
 * category (two "+1 Monster" runes add 2, not 1). `resolutions` is a
 * unit's own resolutions object ({ [type]: { allocations: [...] } }),
 * the same shape whether the unit is just selected or already built -
 * this doesn't care which, since a rune's own tag doesn't change
 * between those two states. Deliberately generic across every possible
 * tag category (not just the 4 seen in the current 12-waystone
 * baseline data), so a tag category absent from every baseline still
 * correctly gets tracked rather than silently dropped, if one ever
 * shows up on a real rune. Returns null if this waystone has no
 * composition data on file, rather than a misleadingly empty result. */
function deckComposition(waystoneName, resolutions, deckCompositions) {
  const baseline = deckCompositions?.waystones?.[waystoneName];
  if (!baseline) return null;
  const result = { ...baseline };
  Object.values(resolutions || {}).forEach((res) => {
    (res.allocations || []).forEach((a) => {
      (a.tags || []).forEach((t) => {
        result[t.name] = (result[t.name] || 0) + t.magnitude;
      });
    });
  });
  return result;
}

/**
 * Like bestBuildableOption, but returns EVERY distinct requirement
 * (across all recipe variants and wildcard resolutions) that's
 * currently buildable at least once, not just the best one - lets the
 * UI show every viable route for a single unit, not only whichever one
 * the solver happened to need. Deduplicates requirements that reduce to
 * the identical type/count combination, since different recipe variants
 * - or different wildcard picks within the same variant - can land on
 * the exact same requirement.
 */
function allBuildableOptions(waystone, inventory) {
  const seen = new Map();
  waystone.recipes.forEach((recipe) => {
    expandRecipeOptions(recipe.slots).forEach((req) => {
      const counts = Object.entries(req).map(([type, need]) => Math.floor((inventory[type] || 0) / need));
      const maxQty = counts.length > 0 ? Math.min(...counts) : 0;
      if (maxQty < 1) return;
      const signature = requirementSignature(req);
      if (!seen.has(signature)) seen.set(signature, req);
    });
  });
  return [...seen.values()];
}

/**
 * Try to find a single rune allocation that satisfies every selected
 * waystone at once, given available inventory counts for one tier.
 * Returns { success, assignment: [{waystone, recipeIndex, requirement}], leftover }
 * or { success: false, reason }.
 */
function solveAllocation(selectedWaystones, inventoryForTier) {
  // Precompute every concrete option per waystone (across all its recipes).
  const perWaystoneOptions = selectedWaystones.map((w) => {
    const options = [];
    w.recipes.forEach((recipe, recipeIndex) => {
      for (const requirement of expandRecipeOptions(recipe.slots)) {
        options.push({ recipeIndex, requirement });
      }
    });
    return { waystone: w, options };
  });

  let nodesExplored = 0;
  const working = { ...inventoryForTier };
  const assignment = [];

  function backtrack(i) {
    if (nodesExplored++ > CONFIG.SOLVER_NODE_LIMIT) return "limit";
    if (i === perWaystoneOptions.length) return true;

    const { waystone, options } = perWaystoneOptions[i];
    for (const option of options) {
      const req = option.requirement;
      const canAfford = Object.entries(req).every(
        ([type, need]) => (working[type] || 0) >= need
      );
      if (!canAfford) continue;

      Object.entries(req).forEach(([type, need]) => (working[type] -= need));
      assignment.push({ waystone: waystone.name, recipeIndex: option.recipeIndex, requirement: req });

      const result = backtrack(i + 1);
      if (result === true) return true;
      if (result === "limit") return "limit";

      // backtrack
      assignment.pop();
      Object.entries(req).forEach(([type, need]) => (working[type] += need));
    }
    return false;
  }

  const result = backtrack(0);
  if (result === true) {
    return { success: true, assignment, leftover: working };
  }
  if (result === "limit") {
    return { success: false, reason: "Search limit reached - try selecting fewer waystones at once." };
  }
  return { success: false, reason: "No allocation of your current runes satisfies all selected waystones together." };
}

// Exported for app-ui.js
export const PradoApp = {
  CONFIG,
  RUNE_TYPES,
  TAG_NAMES,
  TYPE_ICONS,
  state,
  itemKey,
  migrateInventory,
  saveInventory,
  addToInventory,
  getTierTypeTotal,
  getFilteredTierTypeTotal,
  getFilteredTierTypeCandidates,
  resolveTypeAllocation,
  parseScreenshot,
  clusterAndExtract,
  expandRecipeOptions,
  bestBuildableOption,
  allBuildableOptions,
  requirementSignature,
  deckComposition,
  countTagBadgeRows,
  findAllTagMatches,
  detectBackgroundColor,
  colorDistanceSq,
  suggestAffixGuess,
  computeMissingParts,
  solveAllocation,
  flagDuplicates,
  sortForDuplicateReview,
};

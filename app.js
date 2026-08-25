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
  // Bumped from 2 to 2.5 specifically to address one of two distinct
  // deck-tag OCR failure modes found via the raw per-line debug output
  // (Troubleshooting Mode): sometimes Tesseract detects the small
  // colored-pill tag badge as a text region but reads it at very low
  // confidence (seen as low as 12%, producing pure garbage like
  // "7 MBe 109") - more resolution genuinely tends to help resolve
  // character shapes Tesseract can barely make out.
  //
  // 2 -> 2.5 measured literally zero difference on the same known test
  // rows - real evidence that resolution wasn't the binding constraint
  // at that increment. Pushed further to 4 rather than another small
  // step, at explicit request accepting the real speed cost (16x the
  // pixels vs. the original, a meaningfully heavier OCR pass) - a
  // bigger jump actually tests whether there's a threshold effect
  // (the tag text sitting below some minimum pixel-height Tesseract
  // needs to resolve character shapes at all) that a small increment
  // wouldn't have crossed, rather than just repeating the same
  // inconclusive small-step result. Still not expected to help the
  // separate "Tesseract detects no text region there at all" failure
  // mode, since that's a detection failure rather than a resolution
  // problem.
  OCR_UPSCALE_FACTOR: 4,
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
  // Keyed by tier|type|prefix|suffix|tagName|tagMagnitude - see itemKey().
  // Each value is { tier, type, prefix, suffix, tagName, tagMagnitude,
  // count }. Items with no prefix/suffix (OCR couldn't read a name, or a
  // manual adjustment with no name specified) share the "Unknown|Unknown"
  // bucket per tier+type+tag. Same for tagName/tagMagnitude - no tag
  // read/entered falls into the tag-Unknown bucket for that combination.
  inventory: loadInventory(),
  pendingRows: [], // rows from the most recent screenshot, awaiting confirm
  waystoneData: null, // loaded from recipes.json
};

function itemKey(tier, type, prefix, suffix, tagName, tagMagnitude) {
  return `${tier}|${type}|${prefix || "Unknown"}|${suffix || "Unknown"}|${tagName || "Unknown"}|${tagMagnitude ?? "Unknown"}`;
}

/**
 * Normalizes inventory data to the current { tier, type, prefix, suffix,
 * tagName, tagMagnitude, count } shape. Handles the pre-prefix/suffix
 * format, where values were plain counts keyed by "tier|type" - those
 * fold into that tier+type's Unknown/Unknown/no-tag bucket. Also
 * re-keys any entry saved before tag tracking existed (has tier/type/
 * prefix/suffix/count but no tagName/tagMagnitude) under the current
 * itemKey signature, rather than passing its old key through unchanged -
 * tag fields default to null/Unknown for these, but the key itself has
 * to be recomputed so the entry stays correctly addressable and merges
 * properly with anything added later under the new scheme.
 */
function migrateInventory(raw) {
  const migrated = {};
  Object.entries(raw || {}).forEach(([key, value]) => {
    if (typeof value === "number") {
      const [tierStr, type] = key.split("|");
      const tier = parseInt(tierStr, 10);
      if (!type || Number.isNaN(tier)) return;
      const newKey = itemKey(tier, type, null, null, null, null);
      if (!migrated[newKey]) {
        migrated[newKey] = { tier, type, prefix: null, suffix: null, tagName: null, tagMagnitude: null, count: 0 };
      }
      migrated[newKey].count += value;
    } else if (value && typeof value === "object" && typeof value.count === "number") {
      const tagName = value.tagName || null;
      const tagMagnitude = value.tagMagnitude ?? null;
      const newKey = itemKey(value.tier, value.type, value.prefix, value.suffix, tagName, tagMagnitude);
      if (!migrated[newKey]) {
        migrated[newKey] = {
          tier: value.tier,
          type: value.type,
          prefix: value.prefix || null,
          suffix: value.suffix || null,
          tagName,
          tagMagnitude,
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
function addToInventory(tier, type, prefix, suffix, tagName, tagMagnitude, delta) {
  const key = itemKey(tier, type, prefix, suffix, tagName, tagMagnitude);
  if (!state.inventory[key]) {
    state.inventory[key] = {
      tier,
      type,
      prefix: prefix || null,
      suffix: suffix || null,
      tagName: tagName || null,
      tagMagnitude: tagMagnitude ?? null,
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
      tagName: item.tagName,
      tagMagnitude: item.tagMagnitude,
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
          tagName: chosen.tagName,
          tagMagnitude: chosen.tagMagnitude,
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
        tagName: c.tagName,
        tagMagnitude: c.tagMagnitude,
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
  // rawLines is returned (not just logged) so the UI can show exactly
  // what Tesseract detected directly on the page - no DevTools required.
  return { rows, rawLines: lines };
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
function computeMissingParts(prefix, suffix, tagName, tagMagnitude) {
  const missingParts = [];
  if (!prefix) missingParts.push("Fortune");
  if (!suffix) missingParts.push("Omen");
  // A tag genuinely needs both pieces together - a name with no
  // magnitude (or vice versa) is just as incomplete as having neither,
  // since the in-game badge always shows them as one unit ("+1 Rest",
  // never just "Rest" alone).
  if (!tagName || tagMagnitude == null) missingParts.push("Tag");
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
  // Tag badges read like "+1 Rest" or "+2 Monster" - a leading number
  // and a name, matched together as one unit against the known tag
  // vocabulary (TAG_NAMES) rather than reusing the plain name-only
  // affix matcher above, since a tag genuinely needs both pieces, not
  // just the name. The "+" is optional in the pattern - OCR can just as
  // easily drop or misread that one character as get it right, and the
  // number+name combination is already distinctive enough on its own
  // without requiring it.
  const tagRegex = new RegExp(`\\+?\\s*(\\d+)\\s*(${TAG_NAMES.join("|")})\\b`, "i");

  const tierHeaders = []; // { tier, top }
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
      tierHeaders.push({ tier: parseInt(tierMatch[1], 10), top });
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

    // The tag badge sits visually below the name, but the whole cluster
    // is searched (not just afterType) rather than assuming OCR line
    // order always puts it strictly after the suffix - the "+N TagName"
    // pattern is distinctive enough that searching the full blob doesn't
    // risk a false match against unrelated text elsewhere in the entry.
    const tagMatch = blob.match(tagRegex);
    const tagName = tagMatch ? TAG_NAMES.find((t) => t.toLowerCase() === tagMatch[2].toLowerCase()) : null;
    const tagMagnitude = tagMatch ? parseInt(tagMatch[1], 10) : null;

    const confidence = cluster.reduce((sum, l) => sum + l.confidence, 0) / cluster.length;
    // What actually needs a human's attention now is whether the fields
    // that matter resolved cleanly against known vocabulary - not
    // Tesseract's raw per-line confidence, which gets dragged down by
    // junk text (a tag chip, a coin value) that never mattered in the
    // first place and gets discarded regardless. Type is guaranteed
    // present here (the entry wouldn't exist otherwise); prefix/suffix/
    // tag are the ones that can genuinely come back unmatched.
    const missingParts = computeMissingParts(prefix, suffix, tagName, tagMagnitude);

    entries.push({
      type,
      prefix,
      suffix,
      tagName,
      tagMagnitude,
      suggestedPrefix,
      suggestedSuffix,
      blob,
      top,
      bottom,
      midY,
      confidence,
      missingParts,
      inlineTier: tierMatch ? parseInt(tierMatch[1], 10) : null,
    });
  });

  tierHeaders.sort((a, b) => a.top - b.top);
  const margin = typicalLineHeight * CONFIG.EDGE_MARGIN_RATIO;

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
    return {
      id: `${Date.now()}-${idx}`,
      type: e.type,
      tier,
      prefix: e.prefix,
      suffix: e.suffix,
      tagName: e.tagName,
      tagMagnitude: e.tagMagnitude,
      suggestedPrefix: e.suggestedPrefix,
      suggestedSuffix: e.suggestedSuffix,
      rawText: e.blob,
      confidence: e.confidence,
      needsReview: e.missingParts.length > 0,
      missingParts: e.missingParts,
      clipped,
      included: !clipped,
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
    // prefix/suffix - two rows both showing an unresolved tag could be
    // genuinely different runes that each just failed to read, not
    // actual duplicates, so they're excluded rather than risk a false
    // positive.
    if (!r.prefix || !r.suffix || !r.tagName || r.tagMagnitude == null) return;
    const key = `${r.tier}|${r.type}|${r.prefix}|${r.suffix}|${r.tagName}|${r.tagMagnitude}`;
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
  suggestAffixGuess,
  computeMissingParts,
  solveAllocation,
  flagDuplicates,
  sortForDuplicateReview,
};

import { PradoApp } from "./app.js";

const { state, itemKey, saveInventory, addToInventory, getTierTypeTotal, getFilteredTierTypeTotal, getFilteredTierTypeCandidates, resolveTypeAllocation, parseScreenshot, solveAllocation, bestBuildableOption, allBuildableOptions, requirementSignature, deckComposition, computeMissingParts, flagDuplicates, sortForDuplicateReview, TYPE_ICONS, RUNE_TYPES, TAG_NAMES } =
  PradoApp;

const MAX_TIER = 5; // runes go up to Tier 5 in-game; recipes.json defines each waystone once and loadRecipes() expands it across all 5 tiers

// A generous ceiling well above any real screenshot (even a large 4K
// capture is typically a few MB), meant to catch an accidentally- or
// maliciously-huge file before attempting to decode it - decoding an
// enormous or specially-crafted image can hang or crash the tab, and
// there's otherwise nothing stopping someone from selecting a
// multi-gigabyte file regardless of the file picker's own filtering.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

// Counts screenshots across the current review session, not just within
// one upload action - lets "Screenshot N" labels stay correct whether
// someone selects several photos at once or uploads one at a time across
// several separate picks (the common mobile pattern, since a photo
// picker's own multi-select gesture isn't always obvious). Resets when
// the pending list is cleared (on confirm), starting a fresh session.
let screenshotCounter = 0;

// Ticks up every time a waystone selection newly becomes committed
// (checked + a valid quantity) - each commitment's own value is stored
// on its selection as commitOrder, so "older clicks have priority" can
// be enforced by actual click order rather than display order.
let commitOrderCounter = 0;

// Holds the current "Find Combinations" results, once solved - null when
// nothing's been solved yet or the tab/selection has changed underneath
// it. Each card tracks its own checked/built status and, once built,
// each unit's per-type resolution (which specific named stack(s) got
// used), so re-rendering after a checkbox toggle or a "change" pick
// doesn't need to re-run the solver.
let resultsState = null;

// Single-level undo for the most recent "Build Selected" click - not a
// full history, just "undo the last build action", matching the actual
// ask. Holds { inventorySnapshot, units } for exactly the units that
// specific click actually built (not ones already built in an earlier,
// separate click), so undo can't accidentally revert something outside
// what the user just did. Cleared whenever a new build happens (that
// batch's snapshot replaces this one) or once undo is actually used.
let lastBuildUndo = null;

function stackLabel(prefix, suffix) {
  if (!prefix && !suffix) return "unresolved";
  return escapeHtml(`${prefix || "?"}/${suffix || "?"}`);
}

/** "2× City + Mask" style formatting for a requirement object ({type:
 * count, ...}) - shared between the primary requirement line and the
 * "other options" list, since both need the exact same formatting. */
function formatRequirement(req) {
  return Object.entries(req)
    .map(([t, n]) => (n > 1 ? `${n}× ${t}` : t))
    .join(" + ");
}

/** Fortune tags render in square brackets, Omen tags in angle brackets -
 * a shape difference, not just a color difference, so the distinction
 * still holds for anyone who can't rely on the blue/rust coloring. */
function affixTagHtml(name, isOmen) {
  if (!name) return "";
  const list = isOmen ? affixState.data?.omens : affixState.data?.fortunes;
  const entry = list?.find((a) => a.name === name);
  if (!entry?.abbrev) return "";
  const cls = isOmen ? "affix-tag-omen" : "affix-tag-fortune";
  const brackets = isOmen ? [`&lt;`, `&gt;`] : ["[", "]"];
  const title = entry.effect ? ` title="${escapeHtml(`${name} - ${entry.effect}`)}"` : "";
  return `<span class="${cls}"${title}>${brackets[0]}${escapeHtml(entry.abbrev)}${brackets[1]}</span>`;
}

/** Same lookup as affixTagHtml, but plain text - <option> elements never
 * render HTML markup inside their text, so the colored span there would
 * just show up as literal, broken-looking tag characters on screen. */
function plainAffixTag(name, isOmen) {
  if (!name) return "";
  const list = isOmen ? affixState.data?.omens : affixState.data?.fortunes;
  const entry = list?.find((a) => a.name === name);
  if (!entry?.abbrev) return "";
  const safe = escapeHtml(entry.abbrev);
  return isOmen ? `&lt;${safe}&gt;` : `[${safe}]`;
}

function allocationTagsHtml(prefix, suffix) {
  return affixTagHtml(prefix, false) + affixTagHtml(suffix, true);
}

// "Deck tag" here means the "+1 Rest"/"+2 Monster" deck-modifier badge -
// distinct from the trait tags above (affixTagHtml/allocationTagsHtml),
// which are the bracketed Fortune/Omen indicators. Named and commented
// explicitly to avoid confusion between the two "tag" concepts, which
// now appear right next to each other in these same result lines.
function deckTagHtml(tagName, tagMagnitude) {
  if (!tagName) return "";
  return ` <span class="deck-tag">+${tagMagnitude ?? "?"} ${escapeHtml(tagName)}</span>`;
}

// Plain-text equivalent for <option> labels, which can't render HTML -
// same reason plainAffixTag exists alongside affixTagHtml above.
function plainDeckTag(tagName, tagMagnitude) {
  if (!tagName) return "";
  return `+${tagMagnitude ?? "?"} ${tagName}`;
}

/** Renders the "expected deck" preview - the actual resulting card
 * counts a specific set of resolutions would produce, per
 * deckComposition() in app.js (waystone baseline + each used rune's
 * own tag contribution). "Deck composition" deliberately distinct
 * naming from "deck tag" (a single rune's own +N badge) and "trait
 * tag" (the bracketed Fortune/Omen indicators) - three genuinely
 * different "tag"-adjacent concepts now coexist in this app, and
 * conflating any of their names/labels would be genuinely confusing.
 * Returns "" (renders nothing) if this waystone has no composition
 * data on file yet, or if deck-compositions.json hasn't loaded -
 * silent, graceful absence rather than an error or a placeholder,
 * matching how this app already treats other still-loading/missing
 * data elsewhere. */
function deckCompositionHtml(waystoneName, resolutions) {
  const composition = deckComposition(waystoneName, resolutions, state.deckCompositions);
  if (!composition) return "";
  const pills = Object.entries(composition)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `<span class="deck-comp-pill"><span class="deck-comp-count">${count}</span> ${escapeHtml(category)}</span>`)
    .join("");
  if (!pills) return "";
  return `<div class="deck-comp-preview">
    <p class="deck-comp-label">Expected deck</p>
    <div class="deck-comp-row">${pills}</div>
  </div>`;
}

// Tracks each waystone's checkbox/quantity across re-renders, keyed by
// "tier|name" - tier-qualified since a future Tier 2-5 waystone isn't
// guaranteed to have a name unique across tiers, only within one. Not
// persisted - this is working state for the current session's "what am
// I planning to build" question, not part of the saved inventory.
const waystoneSelections = {};
function selKey(tier, name) {
  return `${tier}|${name}`;
}

// Per-tier Fortune/Omen availability filters, feeding into the pool the
// crafting math draws from. undefined means "use the default" rather
// than an empty Set, so the default tracks the current known affix list
// live (e.g. if rune-affixes.json grows) instead of freezing whatever
// was known the first time a tier was viewed:
//   fortuneFilters[tier] undefined -> every Fortune usable (the default)
//   omenFilters[tier]    undefined -> no Omen avoided (the default)
const fortuneFilters = {};
const omenFilters = {};

let activeTier = 1;

const els = {
  fileInput: document.getElementById("file-input"),
  previewStrip: document.getElementById("preview-strip"),
  progress: document.getElementById("ocr-progress"),
  pendingRows: document.getElementById("pending-rows"),
  confirmBtn: document.getElementById("confirm-add"),
  clearPendingBtn: document.getElementById("clear-pending"),
  inventoryTable: document.getElementById("inventory-table"),
  waystoneList: document.getElementById("waystone-list"),
  tierTabs: document.getElementById("tier-tabs"),
  solveBtn: document.getElementById("solve-btn"),
  results: document.getElementById("results"),
  resetBtn: document.getElementById("reset-inventory"),
  debugPanel: document.getElementById("debug-panel"),
  debugOutput: document.getElementById("debug-output"),
  troubleshootingToggle: document.getElementById("troubleshooting-toggle"),
  colorblindToggle: document.getElementById("colorblind-toggle"),
  tutorialOpen: document.getElementById("tutorial-open"),
  tutorialDialog: document.getElementById("tutorial-dialog"),
  tutorialClose: document.getElementById("tutorial-close"),
  tutorialCloseX: document.getElementById("tutorial-close-x"),
  manualAddOpen: document.getElementById("manual-add-open"),
  manualAddDialog: document.getElementById("manual-add-dialog"),
  manualAddClose: document.getElementById("manual-add-close"),
  manualAddSubmit: document.getElementById("manual-add-submit"),
  manualAddStatus: document.getElementById("manual-add-status"),
  manualTier: document.getElementById("manual-tier"),
  manualType: document.getElementById("manual-type"),
  manualFortune: document.getElementById("manual-fortune"),
  manualOmen: document.getElementById("manual-omen"),
  manualTagName: document.getElementById("manual-tag-name"),
  manualTagMagnitude: document.getElementById("manual-tag-magnitude"),
};

// --- Troubleshooting Mode -------------------------------------------------
// Gates the per-row raw OCR text and the debug panel - both are noise for
// normal use, but useful when something needs diagnosing. Persisted so it
// stays set across reloads once someone's turned it on for a session.
const troubleshootingState = { on: localStorage.getItem("waystone-forge-troubleshooting-mode") === "true" };
els.troubleshootingToggle.checked = troubleshootingState.on;

els.troubleshootingToggle.addEventListener("change", (e) => {
  troubleshootingState.on = e.target.checked;
  localStorage.setItem("waystone-forge-troubleshooting-mode", String(troubleshootingState.on));
  if (!troubleshootingState.on) {
    els.debugPanel.classList.add("hidden");
  } else if (els.debugOutput.textContent) {
    els.debugPanel.classList.remove("hidden");
  }
  renderPendingRows();
});

// --- Colorblind Mode --------------------------------------------------
// Adds a check/X to the tier tabs specifically - that's the one place
// that relies on color alone with no other indicator. Row-level
// green/red is already backed up by the quantity number itself (0 vs
// a real number tells you the same thing color does), so this
// deliberately doesn't touch rows - just the tabs, and only when on,
// since a check/X on every tab all the time would be visual clutter
// for people who don't need it.
const colorblindState = { on: localStorage.getItem("waystone-forge-colorblind-mode") === "true" };
els.colorblindToggle.checked = colorblindState.on;

els.colorblindToggle.addEventListener("change", (e) => {
  colorblindState.on = e.target.checked;
  localStorage.setItem("waystone-forge-colorblind-mode", String(colorblindState.on));
  if (state.waystoneData) renderWaystoneList();
});

// Button-triggered, not shown automatically on first visit - most of
// the workflow already teaches itself inline (the Do/Don't box, the
// manual-add dialog's own hint text, the empty-state guidance), and a
// "seen it once" flag would be a new kind of persistence this app has
// deliberately avoided elsewhere. No state to track: it just opens and
// closes, same as the manual-add dialog.
els.tutorialOpen.addEventListener("click", () => els.tutorialDialog.showModal());
els.tutorialClose.addEventListener("click", () => els.tutorialDialog.close());
els.tutorialCloseX.addEventListener("click", () => els.tutorialDialog.close());

function renderDebugPanel(debugLines) {
  if (!els.debugPanel || debugLines.length === 0 || !troubleshootingState.on) return;
  els.debugPanel.classList.remove("hidden");
  els.debugOutput.textContent = debugLines
    .map(({ label, lines, tagRetryDebug }) => {
      const mainSection =
        `${label}:\n` +
        lines
          .map((l) => `  [${Math.round(l.confidence)}%] "${l.text}"  (y: ${Math.round(l.y0)}-${Math.round(l.y1)})`)
          .join("\n");
      // Second-pass targeted tag-crop retries, if any ran for this
      // screenshot - shown separately from the main per-line output
      // above so a still-failing retry can actually be diagnosed: was
      // the crop region positioned wrong (garbage/unrelated text at
      // this section), or was it right but genuinely unreadable even
      // at this much higher zoom (blank or near-blank output).
      if (!tagRetryDebug || tagRetryDebug.length === 0) return mainSection;
      const retrySection =
        `  Tag crop retries:\n` +
        tagRetryDebug
          .map(({ rowLabel, cropTop, cropBottom, lines: cropLines, matched, skippedReason }) => {
            const header = `    ${rowLabel}  (crop y: ${Math.round(cropTop)}-${Math.round(cropBottom)})  ${matched ? "MATCHED" : "no match"}`;
            if (skippedReason) return `${header} - skipped: ${skippedReason}`;
            if (cropLines.length === 0) return `${header}\n      (nothing detected in crop)`;
            return (
              header +
              "\n" +
              cropLines.map((l) => `      [${Math.round(l.confidence)}%] "${l.text}"`).join("\n")
            );
          })
          .join("\n");
      return `${mainSection}\n${retrySection}`;
    })
    .join("\n\n");
}

const affixState = { data: null }; // { fortunes: [...], omens: [...] } once loaded

async function loadAffixes() {
  try {
    const res = await fetch("rune-affixes.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    affixState.data = await res.json();
    // recipes.json and rune-affixes.json load independently - if this
    // finishes after the waystone list already rendered (without the
    // Fortune/Omen filter rows, since affix names weren't known yet),
    // render it again now that they are.
    if (state.waystoneData) renderWaystoneList();
  } catch (err) {
    console.error("Couldn't load rune-affixes.json:", err);
    // Non-fatal: parsing still works, just without prefix/suffix matching.
  }
}

function iconSvg(type) {
  return `<svg class="rune-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${TYPE_ICONS[type] || ""}</svg>`;
}

// --- Screenshot upload + OCR -------------------------------------------------

els.fileInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;

  els.previewStrip.innerHTML = "";
  els.previewStrip.classList.remove("hidden");
  els.progress.classList.remove("hidden");
  els.progress.classList.remove("error");

  if (typeof Tesseract === "undefined") {
    els.progress.classList.add("error");
    els.progress.textContent =
      "OCR engine didn't load. If you opened this file directly (file://...), " +
      "serve it from a local server instead - e.g. run `py -m http.server` " +
      "in this folder and open http://localhost:8000.";
    return;
  }

  const allRows = [];
  const failures = [];
  const debugLines = []; // { label, lines: [{text, confidence, y0, y1}], tagRetryDebug: [{rowLabel, cropTop, cropBottom, lines, matched}] } per screenshot

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    screenshotCounter += 1;
    const label = `Screenshot ${screenshotCounter}`;
    const prefix = `${label}: `;

    try {
      // The file picker's accept="image/*" (see index.html) is a UX
      // filter only - it narrows what the OS picker shows by default,
      // but doesn't stop a file from being selected another way (typing
      // a path, "All Files" in the picker, etc.). These two checks are
      // the real gate before any attempt to decode the file:
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new Error(`too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
      }
      // file.type is the browser's own best-effort read of the file,
      // not something a filename or extension can spoof - but it can
      // come back empty when the browser genuinely can't tell, so only
      // reject a type it's positively reporting as non-image, never an
      // inconclusive empty one.
      if (file.type && !file.type.startsWith("image/")) {
        throw new Error(`not an image (detected type: ${file.type})`);
      }

      const img = new Image();
      img.src = URL.createObjectURL(file);
      await img.decode();

      const thumb = document.createElement("img");
      thumb.src = img.src;
      thumb.className = "preview-thumb";
      thumb.title = file.name;
      els.previewStrip.appendChild(thumb);

      els.progress.textContent = `${prefix}Reading… 0%`;
      const { rows, rawLines, tagRetryDebug } = await parseScreenshot(
        img,
        (pct, phase) => {
          if (phase?.phase === "tagRetry") {
            els.progress.textContent = `${prefix}Refining ${phase.total} tag${phase.total === 1 ? "" : "s"}… ${phase.current}/${phase.total}`;
          } else {
            els.progress.textContent = `${prefix}Reading… ${pct}%`;
          }
        },
        affixState.data
      );
      // sourceImageUrl kept alongside each row so a "show me the crop"
      // preview can regenerate the exact image region later, entirely
      // client-side - img.src is never explicitly revoked anywhere in
      // this flow, so it stays valid for the review session.
      rows.forEach((r) => {
        r.sourceLabel = label;
        r.sourceImageUrl = img.src;
      });
      allRows.push(...rows);
      debugLines.push({ label, lines: rawLines, tagRetryDebug });
    } catch (err) {
      console.error(err);
      failures.push(`${escapeHtml(file.name)}: ${escapeHtml(err.message)}`);
    }
  }

  els.progress.classList.add("hidden");
  renderDebugPanel(debugLines);

  // Appended to whatever's already pending (not confirmed yet), not
  // replaced - uploading a second screenshot used to silently wipe out
  // an unconfirmed first one, which is exactly what forced a "upload,
  // confirm, upload again" cycle instead of reviewing everything at once.
  state.pendingRows = flagSortAndAutoUncheck([...state.pendingRows, ...allRows]);
  renderPendingRows();

  if (failures.length > 0) {
    els.pendingRows.insertAdjacentHTML(
      "afterbegin",
      `<p class="warn">Couldn't read ${failures.length} of ${files.length} screenshot(s) - ${failures.join("; ")}</p>`
    );
  }
});

// The Omen effect text for Tenacity/Withering contains a raw "&", which
// needs escaping before it goes into an HTML attribute.
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** includeUnknown defaults true, since that's what the OCR review rows
 * need (a garbled or unmatched read genuinely might be unresolvable).
 * The manual-add dialog is the one caller that turns it off - there's
 * no legitimate "unknown" case when the user is looking at their own
 * inventory and picking exactly what they see. */
function affixOptions(names, selected, includeUnknown = true) {
  const opts = includeUnknown ? [`<option value="" ${!selected ? "selected" : ""}>Unknown</option>`] : [];
  (names || []).forEach((n) => {
    const safe = escapeHtml(n);
    opts.push(`<option value="${safe}" ${n === selected ? "selected" : ""}>${safe}</option>`);
  });
  return opts.join("");
}

// The clipped notice is always shown (it explains an auto-excluded row);
// the raw OCR text is troubleshooting detail, hidden in the normal view.
/** Updates just one row's own needs-review class/badge in place, without
 * re-rendering the row (which would rebuild its DOM and kick focus out
 * of whatever input the user is actively typing in - a real problem
 * specifically for the tag magnitude field, whose native "change" event
 * only fires on blur, not per keystroke like a dropdown selection does).
 * Called on "input" for that one field specifically, so the status
 * updates live as the user types, the same way picking a Fortune/Omen/
 * Tag name from a dropdown already updates it immediately. */
function updateRowNeedsReviewUI(rowEl, row) {
  rowEl.classList.toggle("needs-review", row.needsReview);
  const existingBadge = rowEl.querySelector('[data-role="needs-review-badge"]');
  if (row.needsReview) {
    const text = `needs review - missing ${row.missingParts.join(" & ")}`;
    if (existingBadge) {
      existingBadge.textContent = text;
    } else {
      const rowNote = rowEl.querySelector(".row-note");
      rowNote?.insertAdjacentHTML(
        "beforebegin",
        `<span class="row-badge badge-needs-review" data-role="needs-review-badge">${escapeHtml(text)}</span>`
      );
    }
  } else if (existingBadge) {
    existingBadge.remove();
  }
}

function rowNoteHtml(row) {
  const parts = [];
  // Only worth showing when the current pending batch actually spans
  // more than one screenshot - a single-source batch doesn't need the
  // label cluttering every row.
  const showSource = row.sourceLabel && new Set(state.pendingRows.map((r) => r.sourceLabel)).size > 1;
  if (showSource) {
    // Same priority as the row's border color when a row is both flags
    // at once: duplicate takes precedence over needs-review.
    const sourceClass = row.duplicate
      ? "source-tag-duplicate"
      : row.needsReview
        ? "source-tag-needs-review"
        : "";
    parts.push(`<span class="source-tag ${sourceClass}">${row.sourceLabel}</span>`);
  }
  if (row.clipped) {
    parts.push("edge-clipped - excluded by default");
  } else if (row.contaminated) {
    // Same "excluded by default, explain why instead of showing raw
    // OCR text" treatment as clipped - a contaminated row's raw text
    // isn't something a dropdown correction can fix, since the actual
    // problem is the in-game floating tier label corrupting what
    // Tesseract read, not a simple unresolved field.
    parts.push("tier label overlap - excluded by default");
  } else if (troubleshootingState.on || row.needsReview) {
    // Shown unconditionally for needs-review rows (not just when
    // Troubleshooting Mode is on) - the raw OCR text is genuinely
    // actionable here, since garbled text like "M-+bic" is a real hint
    // toward the correct dropdown choice. A cleanly-resolved row still
    // shows nothing unless Troubleshooting Mode is on, so this doesn't
    // reintroduce the clutter that toggle exists to hide.
    parts.push("OCR read: " + escapeHtml(row.rawText));
  }
  return parts.join(" · ");
}

function rowHtml(row, fortuneNames, omenNames) {
  return `
    <div class="pending-row ${row.clipped || row.contaminated ? "clipped" : ""} ${row.needsReview ? "needs-review" : ""}" data-id="${row.id}">
      <label>
        <input type="checkbox" ${row.included ? "checked" : ""} data-role="include" />
        ${iconSvg(row.type)}
        <span class="row-type">${row.type}</span>
        <select data-role="type">
          ${RUNE_TYPES.map((t) => `<option value="${t}" ${t === row.type ? "selected" : ""}>${t}</option>`).join("")}
        </select>
        <select data-role="tier">
          ${[1, 2, 3, 4, 5].map((t) => `<option value="${t}" ${t === row.tier ? "selected" : ""}>Tier ${t}</option>`).join("")}
        </select>
        ${row.needsReview ? `<span class="row-badge badge-needs-review" data-role="needs-review-badge">needs review - missing ${row.missingParts.join(" & ")}</span>` : ""}
        <span class="row-note">${rowNoteHtml(row)}</span>
      </label>
      <div class="row-affixes">
        <label class="affix-field">
          <span class="affix-label">Fortune</span>
          <select data-role="prefix">${affixOptions(fortuneNames, row.prefix)}</select>
          ${row.suggestedPrefix ? `<button type="button" class="suggestion-chip" data-role="apply-suggestion" data-id="${row.id}" data-field="prefix" data-value="${escapeHtml(row.suggestedPrefix)}">Did you mean ${escapeHtml(row.suggestedPrefix)}?</button>` : ""}
        </label>
        <label class="affix-field">
          <span class="affix-label">Omen</span>
          <select data-role="suffix">${affixOptions(omenNames, row.suffix)}</select>
          ${row.suggestedSuffix ? `<button type="button" class="suggestion-chip" data-role="apply-suggestion" data-id="${row.id}" data-field="suffix" data-value="${escapeHtml(row.suggestedSuffix)}">Did you mean ${escapeHtml(row.suggestedSuffix)}?</button>` : ""}
        </label>
        <label class="affix-field">
          <span class="affix-label">Tag</span>
          <div class="tag-combo">
            <span class="tag-plus">+</span>
            <input type="number" min="0" step="1" class="tag-magnitude-input" data-role="tagMagnitude" value="${row.tagMagnitude ?? ""}" placeholder="?" />
            <select data-role="tagName">${affixOptions(TAG_NAMES, row.tagName)}</select>
          </div>
          <button type="button" class="link-btn" data-role="show-crop" data-id="${row.id}">show rune</button>
        </label>
      </div>
      <div class="tag-crop-preview hidden" data-role="tag-crop-preview"></div>
    </div>`;
}

function renderPendingRows() {
  // Contaminated rows (tier-label overlap) are already excluded from
  // being confirmed into inventory (included: false, set at extraction
  // time regardless of this toggle) - this only controls whether the
  // row itself is visually shown at all. Hidden by default to keep the
  // normal review experience clean, since there's nothing a user can
  // usefully do with one (no dropdown fixes a tier-label corruption);
  // shown only in Troubleshooting Mode, where seeing exactly what got
  // excluded and why is the actual point.
  const visibleRows = state.pendingRows.filter((r) => troubleshootingState.on || !r.contaminated);

  if (visibleRows.length === 0) {
    // Distinguishes "genuinely nothing detected" from "rows were
    // detected but every one is currently hidden as tier-label
    // contamination" - the latter needs a different, accurate message
    // rather than implying the screenshot itself produced nothing.
    els.pendingRows.innerHTML =
      state.pendingRows.length > 0
        ? `<p class="empty">All detected rows are currently hidden as tier-label contamination. Turn on Troubleshooting Mode to review them.</p>`
        : `<p class="empty">No rune rows detected. Try a clearer screenshot, or use the manual add option.</p>`;
    els.confirmBtn.classList.add("hidden");
    els.clearPendingBtn.classList.add("hidden");
    return;
  }

  const fortuneNames = affixState.data?.fortunes?.map((f) => f.name) || [];
  const omenNames = affixState.data?.omens?.map((o) => o.name) || [];

  els.confirmBtn.classList.remove("hidden");
  els.clearPendingBtn.classList.remove("hidden");

  // Duplicate rows are drawn inside a shared "halo" wrapper (a container
  // with its own glow) rather than each getting its own badge/border, so
  // the pairing itself is visible at a glance - two adjacent-but-distinct
  // pairs get two distinct halos rather than blurring into one group of
  // four. sortForDuplicateReview already guarantees a group's members sit
  // consecutively, so this only ever needs to look at runs of matching
  // duplicateGroup ids, not search the whole list. Operates on
  // visibleRows (not state.pendingRows directly) - removing hidden
  // contaminated rows from this filtered view doesn't disturb the
  // remaining, visible rows' own consecutive grouping among themselves.
  const htmlParts = [];
  let i = 0;
  while (i < visibleRows.length) {
    const row = visibleRows[i];
    if (row.duplicateGroup != null) {
      const groupId = row.duplicateGroup;
      const groupRows = [];
      while (i < visibleRows.length && visibleRows[i].duplicateGroup === groupId) {
        groupRows.push(visibleRows[i]);
        i++;
      }
      htmlParts.push(
        `<div class="duplicate-halo">
          <div class="duplicate-halo-label">possible duplicate - confirm count</div>
          ${groupRows.map((r) => rowHtml(r, fortuneNames, omenNames)).join("")}
        </div>`
      );
    } else {
      htmlParts.push(rowHtml(row, fortuneNames, omenNames));
      i++;
    }
  }
  els.pendingRows.innerHTML = htmlParts.join("");

  els.pendingRows.querySelectorAll(".pending-row").forEach((rowEl) => {
    const id = rowEl.dataset.id;
    const row = state.pendingRows.find((r) => r.id === id);
    rowEl.querySelector('[data-role="include"]').addEventListener("change", (e) => {
      row.included = e.target.checked;
    });
    rowEl.querySelector('[data-role="type"]').addEventListener("change", (e) => {
      row.type = e.target.value;
      refreshDuplicateFlags();
    });
    rowEl.querySelector('[data-role="tier"]').addEventListener("change", (e) => {
      row.tier = parseInt(e.target.value, 10);
      refreshDuplicateFlags();
    });
    rowEl.querySelector('[data-role="prefix"]').addEventListener("change", (e) => {
      row.prefix = e.target.value || null;
      row.suggestedPrefix = null; // the field's been resolved (or explicitly cleared) either way - stop suggesting
      row.missingParts = computeMissingParts(row.prefix, row.suffix, row.tagName, row.tagMagnitude);
      row.needsReview = row.missingParts.length > 0;
      refreshDuplicateFlags();
    });
    rowEl.querySelector('[data-role="suffix"]').addEventListener("change", (e) => {
      row.suffix = e.target.value || null;
      row.suggestedSuffix = null;
      row.missingParts = computeMissingParts(row.prefix, row.suffix, row.tagName, row.tagMagnitude);
      row.needsReview = row.missingParts.length > 0;
      refreshDuplicateFlags();
    });
    rowEl.querySelector('[data-role="tagName"]').addEventListener("change", (e) => {
      row.tagName = e.target.value || null;
      // Selecting Unknown clears magnitude too, and visually resets the
      // number input to match - same "these two travel together" rule
      // as the manual-add dialog, so a stale leftover number can't sit
      // next to an Unknown tag name.
      if (!row.tagName) {
        row.tagMagnitude = null;
        rowEl.querySelector('[data-role="tagMagnitude"]').value = "";
      }
      row.missingParts = computeMissingParts(row.prefix, row.suffix, row.tagName, row.tagMagnitude);
      row.needsReview = row.missingParts.length > 0;
      refreshDuplicateFlags();
    });
    rowEl.querySelector('[data-role="tagMagnitude"]').addEventListener("input", (e) => {
      // "input" (fires per keystroke) rather than relying only on
      // "change" (fires on blur) - lets the needs-review status update
      // live as the user types, the same way selecting a Fortune/Omen/
      // Tag name from a dropdown already does immediately. Uses the
      // lightweight, targeted update helper rather than a full
      // re-render, since re-rendering here would rebuild this exact
      // input's own DOM node and kick it out of focus mid-typing.
      row.tagMagnitude = parseInt(e.target.value, 10) || null;
      row.missingParts = computeMissingParts(row.prefix, row.suffix, row.tagName, row.tagMagnitude);
      row.needsReview = row.missingParts.length > 0;
      updateRowNeedsReviewUI(rowEl, row);
    });
    rowEl.querySelector('[data-role="tagMagnitude"]').addEventListener("change", () => {
      // Duplicate re-checking is heavier (re-renders the full list) and
      // only needs to happen once the value is actually settled, not on
      // every keystroke - deferred to blur/change, using data the
      // "input" listener above has already kept correct the whole time.
      refreshDuplicateFlags();
    });
  });

  els.pendingRows.querySelectorAll('[data-role="apply-suggestion"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const field = btn.dataset.field; // "prefix" or "suffix"
      const row = state.pendingRows.find((r) => r.id === id);
      if (!row) return;
      row[field] = btn.dataset.value;
      // Clear this field's own suggestion (it's resolved now) - not the
      // other field's, in case that one's still unresolved and still
      // needs its own suggestion shown.
      if (field === "prefix") row.suggestedPrefix = null;
      else row.suggestedSuffix = null;
      row.missingParts = computeMissingParts(row.prefix, row.suffix, row.tagName, row.tagMagnitude);
      row.needsReview = row.missingParts.length > 0;
      refreshDuplicateFlags();
    });
  });

  els.pendingRows.querySelectorAll('[data-role="show-crop"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const row = state.pendingRows.find((r) => r.id === id);
      const rowEl = btn.closest(".pending-row");
      const preview = rowEl?.querySelector('[data-role="tag-crop-preview"]');
      if (!row || !preview) return;

      // Toggle: a second click on an already-open preview just closes
      // it again, rather than redundantly re-rendering - the crop
      // region never changes after the initial OCR pass, so there's
      // nothing to refresh.
      if (!preview.classList.contains("hidden")) {
        preview.classList.add("hidden");
        preview.innerHTML = "";
        return;
      }

      if (row.top == null || row.tagCropBottom == null || !row.sourceImageUrl) {
        preview.textContent = "No source image available for this row.";
        preview.classList.remove("hidden");
        return;
      }

      preview.textContent = "Loading…";
      preview.classList.remove("hidden");

      try {
        const img = new Image();
        img.src = row.sourceImageUrl;
        await img.decode();

        const naturalWidth = img.naturalWidth;
        // Starts at the entry's own top (the rune name/icon), not just
        // tagCropTop (which only covers the tag badge area) - the user
        // asked to see the name and tag together for real context on
        // which rune this actually is, not the tag in isolation.
        const cropTop = Math.max(0, row.top);
        const cropBottom = Math.min(img.naturalHeight, row.tagCropBottom);
        const cropHeight = cropBottom - cropTop;
        if (cropHeight <= 0) {
          preview.textContent = "Couldn't determine a valid crop region for this row.";
          return;
        }

        // Moderate zoom (3x) is plenty for human legibility - unlike
        // the OCR retry pass, this doesn't need Tesseract's aggressive
        // 8x, and deliberately skips the grayscale conversion used
        // there too, since a person benefits from seeing the real
        // badge color, not the version optimized for Tesseract.
        //
        // The canvas itself is still rendered at full 3x resolution
        // (so the underlying image stays crisp), but its CSS width is
        // separately capped to the preview container in style.css
        // (max-width: 100%, height: auto) - previously it displayed at
        // its full, un-scaled pixel width, which on a typical
        // screenshot was far wider than the row itself, forcing
        // horizontal scrolling to see anything. Capping the display
        // size rather than lowering the zoom factor keeps the text
        // legible while fitting the row without scrolling.
        const zoom = 3;
        const canvas = document.createElement("canvas");
        canvas.width = naturalWidth * zoom;
        canvas.height = cropHeight * zoom;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, cropTop, naturalWidth, cropHeight, 0, 0, canvas.width, canvas.height);

        preview.innerHTML = "";
        preview.appendChild(canvas);
      } catch (err) {
        preview.textContent = `Couldn't load the source image: ${err.message || err}`;
      }
    });
  });
}

/**
 * Flags duplicates, re-clusters them adjacently, and auto-unchecks all
 * but the first member of any group that's *newly* forming this pass -
 * a safety net so confirming in a hurry doesn't silently double-count a
 * rune into inventory. Only touches rows transitioning from not-duplicate
 * to duplicate; a group that already existed keeps whatever checked
 * state the user set on it, so a manual recheck (e.g. "I looked, these
 * really are two different runes") never gets silently overridden by an
 * unrelated later edit.
 */
function flagSortAndAutoUncheck(rows) {
  const wasDuplicate = new Map(rows.map((r) => [r.id, r.duplicate === true]));
  flagDuplicates(rows);
  const sorted = sortForDuplicateReview(rows);

  const seenGroups = new Set();
  sorted.forEach((row) => {
    if (row.duplicateGroup == null || wasDuplicate.get(row.id)) return;
    if (seenGroups.has(row.duplicateGroup)) {
      row.included = false;
    } else {
      seenGroups.add(row.duplicateGroup);
    }
  });

  return sorted;
}

/**
 * Re-runs duplicate detection against the current dropdown values and
 * re-renders - called after any type/tier/prefix/suffix edit, since
 * duplicate status is now defined by those exact fields.
 */
function refreshDuplicateFlags() {
  state.pendingRows = flagSortAndAutoUncheck(state.pendingRows);
  renderPendingRows();
}

els.confirmBtn.addEventListener("click", () => {
  state.pendingRows
    .filter((r) => r.included)
    .forEach((r) => addToInventory(r.tier, r.type, r.prefix, r.suffix, r.tagName, r.tagMagnitude, 1));
  saveInventory();
  state.pendingRows = [];
  screenshotCounter = 0; // fresh numbering for the next review session
  renderPendingRows();
  refreshInventoryViews();
  els.fileInput.value = "";
  els.previewStrip.classList.add("hidden");
  els.previewStrip.innerHTML = "";
});

// Discards the current review batch without adding anything to
// inventory - useful now that uploads accumulate across multiple
// separate picks rather than replacing each other, so it's possible to
// lose track of what's piled up and just want a clean restart.
els.clearPendingBtn.addEventListener("click", () => {
  if (state.pendingRows.length > 0 && !confirm("Discard all pending rows? Nothing will be added to your inventory.")) return;
  state.pendingRows = [];
  screenshotCounter = 0;
  renderPendingRows();
  els.fileInput.value = "";
  els.previewStrip.classList.add("hidden");
  els.previewStrip.innerHTML = "";
  els.debugPanel.classList.add("hidden");
  els.debugOutput.textContent = "";
});

// --- Inventory table ----------------------------------------------------

// Colors in the waystone list depend on current inventory totals, so any
// inventory change needs to refresh that list too, not just the table.
// Guarded since recipes.json may not have loaded yet on the very first
// call this makes.
function refreshInventoryViews() {
  renderInventory();
  if (state.waystoneData) renderWaystoneList();
}

function renderInventory() {
  const items = Object.entries(state.inventory)
    .filter(([, item]) => item.count > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (items.length === 0) {
    els.inventoryTable.innerHTML = `<p class="empty">No runes recorded yet.</p>`;
    return;
  }

  // Grouped by tier (subheadings, not tabs) - unlike the waystone tabs,
  // there's no functional reason to only look at one tier's inventory at
  // a time, so keeping it one continuous scannable list but visually
  // separated is the better fit here.
  const byTier = {};
  items.forEach(([key, item]) => {
    (byTier[item.tier] = byTier[item.tier] || []).push([key, item]);
  });

  els.inventoryTable.innerHTML = Object.keys(byTier)
    .sort((a, b) => a - b)
    .map((tier) => {
      const tierItems = byTier[tier];
      const rows = tierItems
        .map(([key, item]) => {
          const name =
            item.prefix && item.suffix
              ? `${escapeHtml(item.prefix)} ${item.type} Rune of ${escapeHtml(item.suffix)}`
              : `${item.type} Rune (Fortune/Omen unknown)`;
          // "Deck tag" here means the "+1 Rest"/"+2 Monster" deck-modifier
          // badge - distinct from the existing bracketed trait tags
          // ([+Spellbook], <Heal>) shown elsewhere for Fortune/Omen.
          const deckTag = item.tagName
            ? ` <span class="deck-tag">+${item.tagMagnitude ?? "?"} ${escapeHtml(item.tagName)}</span>`
            : ` <span class="deck-tag deck-tag-unknown">Tag unknown</span>`;
          // Only shown when it's actually informative - a real stack (2+
          // identical named runes merged into one row) still needs to be
          // visible, a routine single rune doesn't need a "1" next to it.
          const qtyLabel = item.count > 1 ? ` ×${item.count}` : "";
          return `<tr>
              <td>
                <select data-role="edit-tier" data-key="${key}">
                  ${[1, 2, 3, 4, 5].map((t) => `<option value="${t}" ${t === item.tier ? "selected" : ""}>T${t}</option>`).join("")}
                </select>
              </td>
              <td>${iconSvg(item.type)} ${name}${deckTag}${qtyLabel}</td>
            </tr>`;
        })
        .join("");
      return `
        <h3 class="subheading">Tier ${tier}</h3>
        <table>
          <thead><tr><th>Tier</th><th>Name</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join("");

  // Moving an item to a different tier re-keys it (tier is part of the
  // item key) and merges into whatever's already at the target tier, if
  // anything - rather than silently overwriting an existing stack there.
  els.inventoryTable.querySelectorAll('[data-role="edit-tier"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const oldKey = e.target.dataset.key;
      const newTier = parseInt(e.target.value, 10);
      const item = state.inventory[oldKey];
      if (!item || newTier === item.tier) return;

      const newKey = itemKey(newTier, item.type, item.prefix, item.suffix, item.tagName, item.tagMagnitude);
      delete state.inventory[oldKey];
      if (state.inventory[newKey]) {
        state.inventory[newKey].count += item.count;
      } else {
        state.inventory[newKey] = {
          tier: newTier,
          type: item.type,
          prefix: item.prefix,
          suffix: item.suffix,
          tagName: item.tagName,
          tagMagnitude: item.tagMagnitude,
          count: item.count,
        };
      }
      saveInventory();
      refreshInventoryViews();
    });
  });
}

els.resetBtn.addEventListener("click", () => {
  if (!confirm("Clear your entire tracked inventory? This can't be undone.")) return;
  state.inventory = {};
  saveInventory();
  refreshInventoryViews();
});

// --- Waystone selection + solver ----------------------------------------

async function loadRecipes() {
  try {
    const res = await fetch("recipes.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    // The same waystones and recipes apply at every tier 1-5 - only the
    // tier of rune used to satisfy them differs, not the recipe
    // structure itself. recipes.json defines each waystone once (no
    // tier field, by design - see its _comment); this expands that
    // single definition into one tier-tagged copy per tier, which is
    // the shape the rest of the app (solver, filtering, rendering)
    // already expects and needs no changes to keep consuming. Keeping
    // a single definition in the actual data file, rather than
    // hand-duplicating it 5 times there, avoids those 5 copies quietly
    // drifting out of sync with each other whenever a future recipe
    // correction only gets applied to one of them.
    const expanded = [];
    for (let tier = 1; tier <= MAX_TIER; tier++) {
      raw.waystones.forEach((w) => expanded.push({ ...w, tier }));
    }
    state.waystoneData = { ...raw, waystones: expanded };
    renderWaystoneList();
  } catch (err) {
    console.error(err);
    els.waystoneList.innerHTML = `<p class="warn">Couldn't load recipes.json (${err.message}). ` +
      `If you opened index.html directly from disk, browsers block that - serve this folder ` +
      `from a local server instead, e.g. run <code>python3 -m http.server</code> in this folder ` +
      `and open http://localhost:8000.</p>`;
  }
}

/**
 * For each waystone, works out whether there's currently enough stock to
 * build it, subtracts committed selections from the pool as it goes so
 * later waystones reflect what's already been earmarked, AND (as a side
 * effect) fills in the live-suggested max quantity for any field the
 * user hasn't manually typed into yet. Processes waystones in display
 * order (top to bottom) - a simple, predictable first-come-first-served
 * rule when two committed selections would otherwise compete for the
 * same runes. This is a fast greedy check for live UI feedback, not the
 * rigorous joint solve "Find Combinations" does; that button remains the
 * authoritative answer when selections conflict.
 *
 * A committed waystone (checked AND a quantity > 0 set - either alone
 * doesn't count) that fits stays green permanently for this pass, even
 * after its own requirement is subtracted from the pool - it doesn't
 * retroactively turn red because of the very runes it just claimed. A
 * committed waystone whose requested quantity does NOT fit is red - that
 * requested amount genuinely can't be built for it, not the wrong pool.
 * An uncommitted waystone is colored by whether at least one is still
 * buildable from whatever's left in the pool at the point it's reached.
 *
 * The suggested quantity uses bestBuildableOption (the variant/wildcard
 * resolution that maximizes how many can be built), not just any option
 * that happens to fit - and that same chosen requirement is reused for
 * the actual commit, so the number shown and the number actually charged
 * to the pool always agree.
 */
function isCommitted(sel) {
  if (!sel) return false;
  const qty = parseInt(sel.quantity, 10);
  return sel.checked && Number.isFinite(qty) && qty > 0;
}

/** Call after mutating a selection's checked/quantity, passing whether
 * it was committed BEFORE that mutation - assigns a fresh commitOrder
 * on the transition into commitment (a genuinely new click claiming
 * priority), and clears it on the transition out (unchecking or
 * zeroing the quantity relinquishes whatever priority it had; a later
 * re-commit is a new click and goes to the back of the line). Nothing
 * happens if the commitment state didn't actually change. */
function updateCommitOrder(sel, wasCommitted) {
  const nowCommitted = isCommitted(sel);
  if (nowCommitted && !wasCommitted) {
    commitOrderCounter += 1;
    sel.commitOrder = commitOrderCounter;
  } else if (!nowCommitted) {
    sel.commitOrder = null;
  }
}

/**
 * For each waystone, works out whether there's currently enough stock to
 * build it, then subtracts committed selections from the pool - but in
 * COMMIT order (the sequence you actually checked things in, tracked via
 * each selection's commitOrder), not display order. Display order was
 * the original design and it was wrong: "older clicks have priority"
 * only means anything if priority is actually tied to when you clicked,
 * not to where a waystone happens to be listed on the page - a waystone
 * near the top of the list otherwise always wins contested runes
 * regardless of whether you committed to it first, second, or last.
 *
 * Two passes per tier:
 *  1. Committed waystones, sorted by commitOrder, each consuming the
 *     pool as it goes - this is the actual, real claim on shared runes.
 *  2. Uncommitted waystones, colored/suggested against whatever's left
 *     after ALL commitments - independent of each other and of display
 *     order, since each is just a "what if I committed this next"
 *     preview, not a real claim.
 *
 * A committed waystone's quantity is never touched here once it's
 * committed - only an uncommitted, untouched field keeps live-updating.
 * Letting a committed quantity keep silently drifting as other things
 * get committed was the second half of the original bug: an
 * auto-suggested-but-never-typed quantity could erode toward zero after
 * the fact, without the user doing anything to cause it.
 */
function computeWaystoneColors(waystones) {
  const colorByKey = new Map();
  const byTier = {};
  waystones.forEach((w) => (byTier[w.tier] = byTier[w.tier] || []).push(w));

  Object.entries(byTier).forEach(([tierStr, tierWaystones]) => {
    const tier = parseInt(tierStr, 10);
    const remaining = {};
    RUNE_TYPES.forEach(
      (t) => (remaining[t] = getFilteredTierTypeTotal(tier, t, fortuneFilters[tier], omenFilters[tier]))
    );

    tierWaystones.forEach((w) => {
      const key = selKey(w.tier, w.name);
      if (!waystoneSelections[key]) {
        waystoneSelections[key] = { checked: false, quantity: "", quantityTouched: false, commitOrder: null };
      }
    });

    const committedEntries = tierWaystones
      .map((w) => ({ w, key: selKey(w.tier, w.name) }))
      .filter(({ key }) => isCommitted(waystoneSelections[key]))
      .sort((a, b) => (waystoneSelections[a.key].commitOrder || 0) - (waystoneSelections[b.key].commitOrder || 0));

    committedEntries.forEach(({ w, key }) => {
      const sel = waystoneSelections[key];
      const qty = parseInt(sel.quantity, 10);
      const best = bestBuildableOption(w, remaining);
      if (best.maxQuantity >= qty && best.requirement) {
        Object.entries(best.requirement).forEach(([type, need]) => (remaining[type] -= need * qty));
        colorByKey.set(key, "green");
      } else {
        colorByKey.set(key, "red");
      }
    });

    tierWaystones.forEach((w) => {
      const key = selKey(w.tier, w.name);
      const sel = waystoneSelections[key];
      if (isCommitted(sel)) return; // already colored above

      const best = bestBuildableOption(w, remaining);
      if (!sel.quantityTouched) {
        sel.quantity = String(best.maxQuantity);
      }
      colorByKey.set(key, best.maxQuantity > 0 ? "green" : "red");
    });
  });

  return colorByKey;
}

/**
 * Five tabs, one per rune tier - green if at least one waystone at that
 * tier is currently buildable (by the same live colorByKey computation
 * driving the row-level colors), red otherwise. A tier with nothing
 * buildable is red the same way regardless of why - out of runes, or
 * (before recipes.json had any waystones defined at all) genuinely no
 * recipes tracked yet; the content panel explains which when that tab
 * is opened rather than just showing an empty list.
 */
function renderTierTabs(colorByKey) {
  const html = [];
  for (let tier = 1; tier <= MAX_TIER; tier++) {
    const tierWaystones = state.waystoneData.waystones.filter((w) => w.tier === tier);
    const anyGreen = tierWaystones.some((w) => colorByKey.get(selKey(tier, w.name)) === "green");
    const color = anyGreen ? "green" : "red";
    const active = tier === activeTier ? "active" : "";
    const mark = colorblindState.on ? `<span class="tier-tab-mark">${anyGreen ? "✓" : "✗"}</span>` : "";
    html.push(
      `<button type="button" class="tier-tab ${color} ${active}" data-role="tier-tab" data-tier="${tier}">${mark}Tier ${tier}</button>`
    );
  }
  els.tierTabs.innerHTML = html.join("");

  els.tierTabs.querySelectorAll('[data-role="tier-tab"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTier = parseInt(btn.dataset.tier, 10);
      // Results are scoped to whichever tier they were solved for -
      // leaving a stale tier's results (with an actionable Build button
      // still attached to them) visible after switching tabs would be
      // genuinely confusing, not just cosmetically stale. Same
      // reasoning applies to a lingering Undo option.
      resultsState = null;
      lastBuildUndo = null;
      els.results.innerHTML = "";
      renderWaystoneList();
    });
  });
}

function renderWaystoneList() {
  const colorByKey = computeWaystoneColors(state.waystoneData.waystones);
  renderTierTabs(colorByKey);

  const tierWaystones = state.waystoneData.waystones.filter((w) => w.tier === activeTier);

  if (tierWaystones.length === 0) {
    els.waystoneList.innerHTML = `<p class="empty">No Tier ${activeTier} recipes tracked yet.</p>`;
    return;
  }

  const byLocation = {};
  tierWaystones.forEach((w) => {
    byLocation[w.location] = byLocation[w.location] || [];
    byLocation[w.location].push(w);
  });

  let idCounter = 0; // unique per checkbox this render pass, for the label's `for` association

  // Fortune/Omen availability filters, shown above the waystone list for
  // this tier. A checkbox's checked state falls back to the tier's
  // default (all Fortunes usable, no Omens avoided) whenever that tier's
  // filter hasn't been touched yet - see fortuneFilters/omenFilters.
  const fortunes = affixState.data?.fortunes || [];
  const omens = affixState.data?.omens || [];
  const fortuneNames = fortunes.map((f) => f.name); // needed for Set materialization below

  const fortuneFilterHtml =
    fortunes.length === 0
      ? ""
      : `<div class="affix-filter">
      <div class="affix-filter-header">
        <span class="affix-filter-title">Fortunes to use</span>
        <button type="button" class="link-btn" data-role="fortune-select-all">Select All</button>
      </div>
      <div class="affix-filter-chips">
        ${fortunes
          .map(({ name, effect }) => {
            const checked = !fortuneFilters[activeTier] || fortuneFilters[activeTier].has(name);
            return `<label class="affix-chip" title="${escapeHtml(effect)}">
              <input type="checkbox" data-role="fortune-filter" data-name="${name}" ${checked ? "checked" : ""} />
              ${name}
            </label>`;
          })
          .join("")}
      </div>
    </div>`;

  const omenFilterHtml =
    omens.length === 0
      ? ""
      : `<div class="affix-filter">
      <div class="affix-filter-header">
        <span class="affix-filter-title">Omens to avoid</span>
        <button type="button" class="link-btn" data-role="omen-deselect-all">Deselect All</button>
      </div>
      <div class="affix-filter-chips">
        ${omens
          .map(({ name, effect }) => {
            const checked = !!(omenFilters[activeTier] && omenFilters[activeTier].has(name));
            return `<label class="affix-chip" title="${escapeHtml(effect)}">
              <input type="checkbox" data-role="omen-filter" data-name="${name}" ${checked ? "checked" : ""} />
              ${name}
            </label>`;
          })
          .join("")}
      </div>
    </div>`;

  els.waystoneList.innerHTML =
    fortuneFilterHtml +
    omenFilterHtml +
    Object.entries(byLocation)
      .map(
        ([location, waystones]) => `
    <fieldset>
      <legend>${escapeHtml(location)}</legend>
      ${waystones
        .map((w) => {
          const key = selKey(w.tier, w.name);
          const sel = waystoneSelections[key];
          const color = colorByKey.get(key);
          const checkboxId = `wcheck-${idCounter++}`;
          return `<div class="waystone-option ${color}">
            <input type="checkbox" id="${checkboxId}" data-role="target" data-tier="${w.tier}" data-name="${escapeHtml(w.name)}" ${sel.checked ? "checked" : ""} />
            <input type="number" class="qty-input" min="0" step="1"
              data-role="target-qty" data-tier="${w.tier}" data-name="${escapeHtml(w.name)}" value="${sel.quantity}" />
            <label for="${checkboxId}">${escapeHtml(w.name)}</label>
          </div>`;
        })
        .join("")}
    </fieldset>`
      )
      .join("");

  els.waystoneList.querySelectorAll('[data-role="fortune-filter"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const name = e.target.dataset.name;
      if (!fortuneFilters[activeTier]) {
        // First touch this tier's Fortune filter - materialize the
        // default ("everything allowed") into an actual set so this one
        // name can be removed from it.
        fortuneFilters[activeTier] = new Set(fortuneNames);
      }
      if (e.target.checked) fortuneFilters[activeTier].add(name);
      else fortuneFilters[activeTier].delete(name);
      renderWaystoneList();
    });
  });

  els.waystoneList.querySelectorAll('[data-role="omen-filter"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const name = e.target.dataset.name;
      if (!omenFilters[activeTier]) omenFilters[activeTier] = new Set();
      if (e.target.checked) omenFilters[activeTier].add(name);
      else omenFilters[activeTier].delete(name);
      renderWaystoneList();
    });
  });

  const fortuneSelectAllBtn = els.waystoneList.querySelector('[data-role="fortune-select-all"]');
  if (fortuneSelectAllBtn) {
    fortuneSelectAllBtn.addEventListener("click", () => {
      delete fortuneFilters[activeTier]; // back to the default: everything usable
      renderWaystoneList();
    });
  }

  const omenDeselectAllBtn = els.waystoneList.querySelector('[data-role="omen-deselect-all"]');
  if (omenDeselectAllBtn) {
    omenDeselectAllBtn.addEventListener("click", () => {
      delete omenFilters[activeTier]; // back to the default: nothing avoided
      renderWaystoneList();
    });
  }

  els.waystoneList.querySelectorAll('[data-role="target"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const key = selKey(e.target.dataset.tier, e.target.dataset.name);
      const sel = waystoneSelections[key];
      const wasCommitted = isCommitted(sel);
      sel.checked = e.target.checked;
      updateCommitOrder(sel, wasCommitted);
      renderWaystoneList();
    });
  });
  // "change" (fires on blur/enter), not "input" (fires per keystroke) -
  // re-rendering the whole list on every keystroke would steal focus out
  // of the field the user is still typing in.
  els.waystoneList.querySelectorAll('[data-role="target-qty"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const key = selKey(e.target.dataset.tier, e.target.dataset.name);
      const sel = waystoneSelections[key];
      const wasCommitted = isCommitted(sel);
      // Marking it touched is what stops computeWaystoneColors from
      // overwriting this with a fresh live suggestion on the next
      // render - once you've typed a number, it's yours until you clear
      // it back to blank.
      sel.quantity = e.target.value;
      sel.quantityTouched = e.target.value !== "";
      updateCommitOrder(sel, wasCommitted);
      renderWaystoneList();
    });
  });
}

els.solveBtn.addEventListener("click", () => {
  // Scoped to the active tab's tier - the whole point of the tabs is
  // that you never want to mix tiers into one build anyway, so "Find
  // combinations" only ever needs to look at what's committed here.
  const prefix = `${activeTier}|`;
  const committed = Object.entries(waystoneSelections)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, sel]) => ({ name: key.slice(prefix.length), quantity: parseInt(sel.quantity, 10), checked: sel.checked }))
    .filter((s) => s.checked && Number.isFinite(s.quantity) && s.quantity > 0);

  if (committed.length === 0) {
    resultsState = null;
    lastBuildUndo = null;
    els.results.innerHTML = `<p class="empty">Check at least one Tier ${activeTier} waystone and set a quantity above.</p>`;
    return;
  }

  // Each unit of quantity becomes its own demand slot for the solver -
  // it already treats each array entry independently, so N copies of the
  // same waystone just means the same waystone object appearing N times.
  const selectedWaystones = committed.flatMap(({ name, quantity }) => {
    const w = state.waystoneData.waystones.find((ww) => ww.tier === activeTier && ww.name === name);
    return Array(quantity).fill(w);
  });

  const tier = activeTier;
  const inventoryForTier = {};
  RUNE_TYPES.forEach((t) => {
    inventoryForTier[t] = getFilteredTierTypeTotal(tier, t, fortuneFilters[tier], omenFilters[tier]);
  });

  const result = solveAllocation(selectedWaystones, inventoryForTier);

  if (!result.success) {
    resultsState = null;
    lastBuildUndo = null;
    els.results.innerHTML = `<p class="warn">${result.reason}</p>`;
    return;
  }

  // Multiple units of the same waystone (from a quantity > 1) group under
  // one card, but each unit keeps its own requirement rather than a
  // summed total - "2x City + 2x Mask + 2x River" reads like a single
  // recipe that needs 2 of each, when it's actually two separate builds
  // that each need 1 of each. Units can also legitimately use different
  // wildcard resolutions from each other (if that's what the solver
  // needed to make everything fit jointly), so showing each one's own
  // actual requirement is more accurate too, not just clearer.
  const grouped = {};
  const usedTotals = {};
  result.assignment.forEach((a) => {
    Object.entries(a.requirement).forEach(([t, n]) => (usedTotals[t] = (usedTotals[t] || 0) + n));
    grouped[a.waystone] = grouped[a.waystone] || [];

    // options/selectedOptionIndex are placeholders here - the call to
    // recomputeUnitOptions() below fills them in properly, using the
    // live-reservation model (see that function). preferredSignature is
    // what actually drives selection: it starts as the solver's own
    // pick, and every interactive change updates it, so a unit's choice
    // survives recomputation as long as it's still viable - and resets
    // to "skip" rather than silently jumping to a DIFFERENT recipe the
    // user never chose, if it stops being viable.
    grouped[a.waystone].push({
      waystone: state.waystoneData.waystones.find((w) => w.tier === tier && w.name === a.waystone),
      options: [a.requirement],
      selectedOptionIndex: 0,
      preferredSignature: requirementSignature(a.requirement),
      built: false,
      resolutions: {},
    });
  });

  const leftoverRows = RUNE_TYPES.map((t) => {
    const have = inventoryForTier[t] || 0;
    const used = usedTotals[t] || 0;
    return `<tr><td>${iconSvg(t)} ${t}</td><td class="mono">${have}</td><td class="mono">${used}</td><td class="mono">${have - used}</td></tr>`;
  }).join("");

  // A static planning snapshot from the moment this was solved - stays
  // as "what would building everything here cost in total" regardless
  // of what actually ends up getting built via the buttons below, since
  // those are two different questions (planned cost vs. real-time
  // inventory) and conflating them would make this table's own numbers
  // shift confusingly mid-review.
  const usageTableHtml = `
    <h3>Tier ${tier} rune usage</h3>
    <table>
      <thead><tr><th>Type</th><th>Have</th><th>Used</th><th>Left over</th></tr></thead>
      <tbody>${leftoverRows}</tbody>
    </table>`;

  // A fresh solve invalidates any undo from a previous results view -
  // its snapshot and unit references no longer correspond to what's
  // about to be displayed.
  lastBuildUndo = null;
  resultsState = {
    tier,
    usageTableHtml,
    cards: Object.entries(grouped).map(([name, units]) => ({ name, units })),
  };

  recomputeUnitOptions();
  renderResults();
});

/** Rebuilds the results section from resultsState - called after the
 * initial solve, and again after anything that changes what's shown
 * (a checkbox toggle, a build, or a "change" pick) rather than
 * re-running the solver itself. */
/**
 * Recomputes every unbuilt unit's viable option list against a shared
 * pool, treating every OTHER unbuilt unit's current selection as a live
 * hold on that pool - not just the solver's original assignment. This is
 * what makes the option lists actually reactive: picking "3x Mask" for
 * one unit when only 4 Mask exist correctly removes "3x Mask" as an
 * option everywhere else it would no longer fit, and brings it back the
 * moment that hold is released (a different option gets picked, or the
 * unit is set to skip).
 *
 * Selection is driven by preferredSignature, not a raw index - each
 * unit "wants" a specific requirement, and this re-resolves that want
 * against the fresh option list every time. If the wanted requirement is
 * still buildable, it stays selected (possibly at a new index, since the
 * list itself can reorder). If it's no longer buildable, the unit resets
 * to null (skip) rather than silently jumping to a DIFFERENT recipe the
 * user never actually chose - that matters here since this determines
 * real inventory deductions once "Build Selected" runs.
 *
 * Runs two full passes: resetting one unit's selection in pass 1 can
 * free up pool space that changes what's viable for a DIFFERENT unit,
 * so pass 2 settles that knock-on effect. Further cascades beyond that
 * are vanishingly unlikely to matter in practice for how many units
 * typically compete for the same pool at once.
 */
function recomputeUnitOptions() {
  if (!resultsState) return;
  const tier = resultsState.tier;

  const basePool = {};
  RUNE_TYPES.forEach((t) => (basePool[t] = getFilteredTierTypeTotal(tier, t, fortuneFilters[tier], omenFilters[tier])));

  const allUnits = [];
  resultsState.cards.forEach((card) => {
    card.units.forEach((unit) => {
      if (!unit.built) allUnits.push(unit);
    });
  });

  for (let pass = 0; pass < 2; pass++) {
    allUnits.forEach((unit) => {
      const poolForThisUnit = { ...basePool };
      allUnits.forEach((other) => {
        if (other === unit || other.selectedOptionIndex === null) return;
        const otherReq = other.options[other.selectedOptionIndex];
        if (!otherReq) return;
        Object.entries(otherReq).forEach(([t, n]) => (poolForThisUnit[t] -= n));
      });

      unit.options = allBuildableOptions(unit.waystone, poolForThisUnit);
      const matchIdx = unit.preferredSignature
        ? unit.options.findIndex((opt) => requirementSignature(opt) === unit.preferredSignature)
        : -1;
      unit.selectedOptionIndex = matchIdx >= 0 ? matchIdx : null;
    });
  }
}

function renderResults() {
  if (!resultsState) return;

  const cardHtml = resultsState.cards
    .map((card, cardIdx) => {
      const qtyLabel = card.units.length > 1 ? ` ×${card.units.length}` : "";

      const unitsHtml = card.units
        .map((unit, unitIdx) => {
          if (!unit.built) {
            const optionsHtml = unit.options
              .map((opt, optIdx) => {
                const label = formatRequirement(opt);
                return `<label class="result-unit-radio">
                  <input type="radio" name="unit-opt-${cardIdx}-${unitIdx}" class="result-check" data-role="unit-option" data-card="${cardIdx}" data-unit="${unitIdx}" data-option="${optIdx}" aria-label="Build this ${escapeHtml(card.name)} using: ${escapeHtml(label)}" ${unit.selectedOptionIndex === optIdx ? "checked" : ""} />
                  <span class="recipe-line">${label}</span>
                </label>`;
              })
              .join("");
            const skipHtml = `<label class="result-unit-radio">
              <input type="radio" name="unit-opt-${cardIdx}-${unitIdx}" class="result-check" data-role="unit-skip" data-card="${cardIdx}" data-unit="${unitIdx}" aria-label="Don't build this ${escapeHtml(card.name)}" ${unit.selectedOptionIndex === null ? "checked" : ""} />
              <span class="recipe-line skip-text">Don't build this</span>
            </label>`;
            // Preview only, computed fresh against current live
            // inventory - never stored on the unit itself and never
            // deducts anything, since nothing has actually been built
            // yet. Shown the moment a real option is picked (not just
            // once actually built), so a person can sanity-check a
            // combination before committing to it, per explicit
            // request - "Don't build this" (selectedOptionIndex still
            // null) correctly shows nothing to preview.
            const previewHtml =
              unit.selectedOptionIndex !== null
                ? deckCompositionHtml(card.name, resolveUnitRequirement(unit.options[unit.selectedOptionIndex], resultsState.tier))
                : "";
            return `<div class="result-unit-options">${optionsHtml}${skipHtml}${previewHtml}</div>`;
          }

          // Built: each type in the SELECTED option shows what actually
          // got used, instead of the plain requirement line above.
          const requirement = unit.options[unit.selectedOptionIndex];
          const types = Object.keys(requirement);
          const usedLines = types
            .map((t) => {
              const res = unit.resolutions[t];
              // Always show the type, even when a unit only needs one -
              // this used to be conditional on needing more than one
              // type, on the assumption the plain requirement line above
              // ("3× Mask") already made the type obvious. That line
              // disappears entirely once a unit is built, replaced by
              // these very lines - so for a single-type unit, omitting
              // it here meant the type was gone from the display
              // completely, with nothing left to imply it.
              const typePrefix = `${t} used: `;
              if (res.allocations.length > 1) {
                // Split across multiple stacks - flat text, no "change"
                // affordance (see resolveTypeAllocation for why).
                const parts = res.allocations
                  .map((a) => `${a.count}× ${stackLabel(a.prefix, a.suffix)}${allocationTagsHtml(a.prefix, a.suffix)}${deckTagHtml(a.tagName, a.tagMagnitude)}`)
                  .join(" + ");
                return `<p class="used-line">${typePrefix}${parts}</p>`;
              }
              const a = res.allocations[0];
              const tag = allocationTagsHtml(a.prefix, a.suffix);
              const deckTag = deckTagHtml(a.tagName, a.tagMagnitude);
              const changeLink =
                res.alternatives && res.alternatives.length > 1
                  ? `<button type="button" class="link-btn" data-role="change-alloc" data-card="${cardIdx}" data-unit="${unitIdx}" data-type="${t}">change</button>`
                  : "";
              return `<p class="used-line">${typePrefix}${stackLabel(a.prefix, a.suffix)}${tag}${deckTag}${changeLink}</p>`;
            })
            .join("");
          // Uses the unit's own real, historical resolutions here (not
          // a fresh preview computation like the not-yet-built branch
          // above) - once built, this is what genuinely got used, not
          // a projection. Automatically reflects a "change" swap too,
          // since this re-renders fresh from unit.resolutions every
          // time, the same way the used-lines above already do.
          const compositionHtml = deckCompositionHtml(card.name, unit.resolutions);
          return `<div class="result-unit-built"><span class="built-badge">✓</span>${usedLines}${compositionHtml}</div>`;
        })
        .join("");

      return `<div class="result-card">
        <div class="result-card-header"><h3>${escapeHtml(card.name)}${qtyLabel}</h3></div>
        ${unitsHtml}
      </div>`;
    })
    .join("");

  const selectedCount = resultsState.cards.reduce(
    (sum, card) => sum + card.units.filter((u) => u.selectedOptionIndex !== null && !u.built).length,
    0
  );
  const buildBtn =
    selectedCount > 0
      ? `<button type="button" class="primary build-selected-btn" data-role="build-selected">Build Selected (${selectedCount})</button>`
      : "";
  // Only offered right after the specific batch that created it - never
  // a general multi-step undo history, matching the actual ask.
  const undoBuildBtn = lastBuildUndo
    ? `<button type="button" class="secondary undo-build-btn" data-role="undo-build">Undo Last Build</button>`
    : "";

  // The checklist is only offered once nothing's left to build -
  // selectedCount above is exactly "committed but not yet built", so
  // zero means every committed unit has actually been built. This is a
  // stricter gate than "every unit has a real pick": requiring the
  // actual Build click (not just the picks) means every resolution the
  // checklist reports is real, historical fact, not a still-changeable
  // projection - a radio pick can still flip to a different variant
  // right up until Build is clicked, which would've made a checklist
  // downloaded before that point stale immediately. The residual risk
  // (the stack-swap "change" link, only available AFTER a unit is
  // built) can still make an already-downloaded file stale after the
  // fact - there's no way to reach back into a file already saved to
  // someone's device, so that's a real, accepted limit, not something
  // this gate can close entirely.
  const allUnits = resultsState.cards.flatMap((card) => card.units);
  const committedCount = allUnits.filter((u) => u.selectedOptionIndex !== null).length;
  const readyForChecklist = committedCount > 0 && selectedCount === 0;
  const checklistSection = readyForChecklist
    ? `<button type="button" class="secondary checklist-btn" data-role="download-checklist">Download Build Checklist</button>`
    : "";

  els.results.innerHTML = `
    <div class="results-grid">${cardHtml}</div>
    ${buildBtn}
    ${undoBuildBtn}
    ${checklistSection}
    ${resultsState.usageTableHtml}`;

  const checklistBtn = els.results.querySelector('[data-role="download-checklist"]');
  if (checklistBtn) {
    checklistBtn.addEventListener("click", downloadChecklist);
  }

  els.results.querySelectorAll('[data-role="unit-option"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const unit = resultsState.cards[parseInt(e.target.dataset.card, 10)].units[parseInt(e.target.dataset.unit, 10)];
      const optIdx = parseInt(e.target.dataset.option, 10);
      // The click sets what this unit WANTS - recomputeUnitOptions is
      // what actually resolves that want into a selectedOptionIndex,
      // after checking it against everything every OTHER unit is
      // currently holding.
      unit.preferredSignature = requirementSignature(unit.options[optIdx]);
      recomputeUnitOptions();
      renderResults();
    });
  });

  els.results.querySelectorAll('[data-role="unit-skip"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const unit = resultsState.cards[parseInt(e.target.dataset.card, 10)].units[parseInt(e.target.dataset.unit, 10)];
      unit.preferredSignature = null;
      recomputeUnitOptions();
      renderResults();
    });
  });

  const buildSelectedBtn = els.results.querySelector('[data-role="build-selected"]');
  if (buildSelectedBtn) {
    buildSelectedBtn.addEventListener("click", () => {
      if (!confirm(`Deduct the runes for ${selectedCount} selected build${selectedCount > 1 ? "s" : ""} from your inventory?`)) return;

      // Snapshot BEFORE building - captures exactly which units this
      // specific click is about to build (not ones already built
      // earlier), so undo only ever reverts this batch, never anything
      // outside it. Inventory is deep-cloned since it's plain,
      // serializable data with no functions or circular references.
      const unitsAboutToBuild = [];
      resultsState.cards.forEach((card) => {
        card.units.forEach((unit) => {
          if (unit.selectedOptionIndex !== null && !unit.built) unitsAboutToBuild.push(unit);
        });
      });
      lastBuildUndo = {
        inventorySnapshot: JSON.parse(JSON.stringify(state.inventory)),
        units: unitsAboutToBuild,
      };

      resultsState.cards.forEach((card) => {
        card.units.forEach((unit) => {
          if (unit.selectedOptionIndex !== null && !unit.built) {
            buildUnit(unit, unit.options[unit.selectedOptionIndex], resultsState.tier);
          }
        });
      });
      saveInventory();
      refreshInventoryViews();
      // Building actually mutates real inventory - any still-unbuilt
      // units need their options recomputed against that new reality,
      // not just against everyone else's hypothetical holds.
      recomputeUnitOptions();
      renderResults();
    });
  }

  const undoBuildBtnEl = els.results.querySelector('[data-role="undo-build"]');
  if (undoBuildBtnEl) {
    undoBuildBtnEl.addEventListener("click", () => {
      if (!lastBuildUndo) return;
      state.inventory = lastBuildUndo.inventorySnapshot;
      // Only the specific units THIS batch built get reset - a plain
      // object reference reset (not a deep clone), since built/
      // resolutions are the only two fields buildUnit ever changed on
      // a unit, and every other unit in resultsState (built in an
      // earlier click, or never touched at all) is correctly left
      // exactly as it was.
      lastBuildUndo.units.forEach((unit) => {
        unit.built = false;
        unit.resolutions = {};
      });
      lastBuildUndo = null;
      saveInventory();
      refreshInventoryViews();
      recomputeUnitOptions();
      renderResults();
    });
  }

  els.results.querySelectorAll('[data-role="change-alloc"]').forEach((el) => {
    el.addEventListener("click", () => {
      showChangeDropdown(el, parseInt(el.dataset.card, 10), parseInt(el.dataset.unit, 10), el.dataset.type);
    });
  });
}

/** Resolves and immediately deducts every type `requirement` needs -
 * each resolution queries CURRENT inventory fresh, so a unit processed
 * later in the same batch (whether from the same card or a different
 * one) correctly sees what an earlier unit in the same batch already
 * consumed. `requirement` is passed in rather than read from
 * unit.options internally, since the caller is the one that knows which
 * option the user actually selected. */
/** Pure - computes what each type in a requirement would resolve to
 * (which specific named stack(s), with their tag info) against the
 * current live inventory, without actually deducting anything. Shared
 * by buildUnit (which then additionally deducts each allocation) and
 * the deck-composition preview for a merely-selected, not-yet-built
 * unit - both need the exact same "which specific stack would this
 * requirement draw from" computation, just one of them stops short of
 * actually spending it. */
function resolveUnitRequirement(requirement, tier) {
  const resolutions = {};
  Object.entries(requirement).forEach(([type, neededCount]) => {
    const candidates = getFilteredTierTypeCandidates(tier, type, fortuneFilters[tier], omenFilters[tier]);
    resolutions[type] = resolveTypeAllocation(candidates, neededCount);
  });
  return resolutions;
}

function buildUnit(unit, requirement, tier) {
  unit.resolutions = resolveUnitRequirement(requirement, tier);
  Object.entries(unit.resolutions).forEach(([type, resolution]) => {
    resolution.allocations.forEach((a) => {
      addToInventory(tier, type, a.prefix, a.suffix, a.tagName, a.tagMagnitude, -a.count);
    });
  });
  unit.built = true;
}

/**
 * Builds the checklist's item list from already-built units' real,
 * historical resolutions - the gate in renderResults ensures every
 * committed unit is built before this is ever reachable (nothing left
 * to build, per selectedCount === 0), so there's no not-yet-built case
 * to handle here and nothing hypothetical to compute or undo.
 */
function computeChecklistItems() {
  const items = [];
  resultsState.cards.forEach((card) => {
    card.units.forEach((unit) => {
      if (unit.selectedOptionIndex === null) return; // skipped, not part of the checklist
      items.push({ waystoneName: card.name, resolutions: unit.resolutions });
    });
  });
  return items;
}

/** One checklist line per type in an item's resolution - matches the
 * exact same "Used: X" / split-across-stacks formatting already used
 * in the live results grid, reusing the same helpers, so the
 * downloaded file reads consistently with what's on screen. */
function formatChecklistItemLines(item) {
  return Object.entries(item.resolutions)
    .map(([type, res]) => {
      // Always show the type - same reasoning as the live results view:
      // for a single-type unit, this line is the ONLY place the type
      // appears at all in the checklist, so omitting it isn't a minor
      // brevity trade, it's losing the information entirely.
      const typePrefix = `${type}: `;
      if (res.allocations.length > 1) {
        const parts = res.allocations
          .map((a) => {
            const deckTag = plainDeckTag(a.tagName, a.tagMagnitude);
            return `${a.count}x ${plainStackLabel(a.prefix, a.suffix)}${deckTag ? " " + deckTag : ""}`;
          })
          .join(" + ");
        return `${typePrefix}${parts}`;
      }
      const a = res.allocations[0];
      const deckTag = plainDeckTag(a.tagName, a.tagMagnitude);
      return `${typePrefix}${plainStackLabel(a.prefix, a.suffix)}${deckTag ? " " + deckTag : ""}`;
    })
    .join(" · ");
}

/** Plain-text stack label for the checklist document, which has its own
 * minimal styling and doesn't need the app's HTML-escaping (this text
 * goes through DOM text-node APIs there, not innerHTML - see
 * generateChecklistDocument). */
function plainStackLabel(prefix, suffix) {
  if (!prefix && !suffix) return "unresolved";
  return `${prefix || "?"}/${suffix || "?"}`;
}

/**
 * Builds the complete, self-contained checklist HTML document as a
 * string - no external stylesheet or script, since it has to work
 * opened directly as a local file with no server and possibly no
 * internet connection. Checkbox state persists via a per-export
 * localStorage key scoped to this specific checklist's contents (see
 * the embedded script), with a graceful no-op fallback if localStorage
 * isn't available for whatever origin the file ends up opened under -
 * genuinely uncertain across mobile browsers for local files, so this
 * doesn't assume it always works.
 */
function generateChecklistDocument(items, tier) {
  const storageKey = `waystone-forge-checklist-${Date.now()}`;
  const itemsJson = JSON.stringify(
    items.map((item) => ({
      name: item.waystoneName,
      lines: formatChecklistItemLines(item),
    }))
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tier ${tier} Build Checklist</title>
<style>
  body { background:#14110f; color:#e8dfc8; font-family:system-ui,sans-serif; margin:0; padding:1.25rem; }
  h1 { font-size:1.2rem; margin:0 0 0.25rem; }
  p.note { color:#8b8072; font-size:0.85rem; margin:0 0 1.25rem; }
  .item { display:flex; align-items:flex-start; gap:0.7rem; padding:0.9rem 0; border-bottom:1px solid #3a322a; }
  .item:last-child { border-bottom:none; }
  .item input { width:1.3rem; height:1.3rem; margin-top:0.15rem; accent-color:#c9a227; flex-shrink:0; }
  .item-name { font-weight:600; margin:0 0 0.2rem; }
  .item.checked .item-name, .item.checked .item-lines { text-decoration:line-through; color:#8b8072; }
  .item-lines { color:#c9a227; font-family:ui-monospace,monospace; font-size:0.85rem; margin:0; }
  button.save-copy { display:block; width:100%; margin:0 0 1.25rem; background:#6f9c6f; color:#1a1510;
    border:1px solid #6f9c6f; border-radius:4px; padding:0.6rem 1.1rem; font-weight:600; font-size:0.85rem; }
  button.discard { display:block; margin:2rem auto 0; background:#b4552f; color:#1a1510; border:1px solid #b4552f;
    border-radius:4px; padding:0.6rem 1.1rem; font-weight:600; font-size:0.85rem; }
  #discard-confirm { display:none; text-align:center; margin-top:0.75rem; font-size:0.85rem; color:#8b8072; }
  #discard-confirm button { margin:0 0.3rem; padding:0.4rem 0.8rem; border-radius:4px; border:1px solid #3a322a;
    background:#3a322a; color:#e8dfc8; font-size:0.82rem; }
  #storage-warning { display:none; color:#b4552f; font-size:0.8rem; margin:0 0 1rem; }
</style>
</head>
<body>
<h1>Tier ${tier} Build Checklist</h1>
<p class="note">Snapshot from Waystone Forge - what to reach for as you build each one in-game.
  Checking these off doesn't touch your tracked inventory in the app itself.</p>
<p id="storage-warning">Your browser isn't saving checkbox progress for this file - checks won't
  survive closing this page, but everything still works during this visit. Use <strong>Save a
  copy</strong> below to download your current progress as a new file instead.</p>
<button type="button" class="save-copy" id="save-copy-btn">Save a Copy of This Page</button>
<div id="list"></div>
<button type="button" class="discard" id="discard-btn">Discard This Checklist</button>
<div id="discard-confirm">
  Delete this checklist's saved progress? This can't be undone.
  <button type="button" id="discard-yes">Yes, discard</button>
  <button type="button" id="discard-no">Cancel</button>
</div>
<script>
(function () {
  var STORAGE_KEY = ${JSON.stringify(storageKey)};
  var items = ${itemsJson};
  var storageOk = true;
  var checked = {};

  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) checked = JSON.parse(raw);
  } catch (e) {
    storageOk = false;
  }

  function persist() {
    if (!storageOk) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(checked));
    } catch (e) {
      storageOk = false;
      document.getElementById("storage-warning").style.display = "block";
    }
  }

  if (!storageOk) document.getElementById("storage-warning").style.display = "block";

  var list = document.getElementById("list");
  items.forEach(function (item, i) {
    var row = document.createElement("div");
    row.className = "item" + (checked[i] ? " checked" : "");

    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!checked[i];
    // Checkbox .checked (a live property) doesn't automatically stay in
    // sync with the checked HTML attribute - explicitly mirroring it
    // here is what makes a later outerHTML snapshot ("Save a Copy")
    // actually capture the current state, rather than always
    // serializing back to whatever the box originally started as.
    if (box.checked) box.setAttribute("checked", "");
    box.addEventListener("change", function () {
      checked[i] = box.checked;
      if (box.checked) box.setAttribute("checked", "");
      else box.removeAttribute("checked");
      row.className = "item" + (box.checked ? " checked" : "");
      persist();
    });

    var textWrap = document.createElement("div");
    var name = document.createElement("p");
    name.className = "item-name";
    name.textContent = item.name; // textContent, not innerHTML - safe regardless of content
    var lines = document.createElement("p");
    lines.className = "item-lines";
    lines.textContent = item.lines;

    textWrap.appendChild(name);
    textWrap.appendChild(lines);
    row.appendChild(box);
    row.appendChild(textWrap);
    list.appendChild(row);
  });

  // A plain outerHTML capture works correctly here because everything
  // else that changes at runtime (row.className, the storage-warning's
  // style.display) DOES stay natively in sync with its own HTML
  // representation - the checkbox attribute mirroring above was the
  // one genuine gap that needed explicit handling.
  document.getElementById("save-copy-btn").addEventListener("click", function () {
    var html = "<!DOCTYPE html>\\n" + document.documentElement.outerHTML;
    var blob = new Blob([html], { type: "text/html" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "waystone-forge-tier-${tier}-checklist-" + Date.now() + ".html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById("discard-btn").addEventListener("click", function () {
    document.getElementById("discard-confirm").style.display = "block";
  });
  document.getElementById("discard-no").addEventListener("click", function () {
    document.getElementById("discard-confirm").style.display = "none";
  });
  document.getElementById("discard-yes").addEventListener("click", function () {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    document.body.innerHTML = "<h1>Checklist discarded</h1><p class=\\"note\\">You can close this page.</p>";
  });
})();
</script>
</body>
</html>`;
}

/** Computes the checklist, generates the standalone document, and
 * triggers a normal browser file download - no server involved, same
 * Blob + temporary-anchor pattern used for any client-side download. */
function downloadChecklist() {
  const tier = resultsState.tier;
  const items = computeChecklistItems();
  const html = generateChecklistDocument(items, tier);

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `waystone-forge-tier-${tier}-checklist.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Swaps which single stack a line used - only reachable for lines that
 * had 2+ individually-sufficient candidates, so this always replaces a
 * one-stack allocation with a different one-stack allocation, never a
 * split. Undoes the old deduction and applies the new one. */
function showChangeDropdown(linkEl, cardIdx, unitIdx, type) {
  const unit = resultsState.cards[cardIdx].units[unitIdx];
  const res = unit.resolutions[type];
  const current = res.allocations[0];

  const options = res.alternatives
    .map((alt) => {
      const tags = `${plainAffixTag(alt.prefix, false)} ${plainAffixTag(alt.suffix, true)}`.trim();
      const deckTag = plainDeckTag(alt.tagName, alt.tagMagnitude);
      const label = `${stackLabel(alt.prefix, alt.suffix)} (${alt.count} left)${tags ? " " + tags : ""}${deckTag ? " " + deckTag : ""}`;
      const selected = alt.key === current.key ? "selected" : "";
      return `<option value="${escapeHtml(alt.key)}" ${selected}>${label}</option>`;
    })
    .join("");

  const select = document.createElement("select");
  select.innerHTML = options;
  linkEl.replaceWith(select);
  select.focus();

  select.addEventListener("change", (e) => {
    const chosen = res.alternatives.find((alt) => alt.key === e.target.value);
    if (!chosen || chosen.key === current.key) return;
    // Undo the old allocation, apply the new one - both at the exact
    // count this line needed, never the whole stack.
    addToInventory(resultsState.tier, type, current.prefix, current.suffix, current.tagName, current.tagMagnitude, current.count);
    addToInventory(resultsState.tier, type, chosen.prefix, chosen.suffix, chosen.tagName, chosen.tagMagnitude, -current.count);
    unit.resolutions[type] = { ...res, allocations: [{ ...chosen, count: current.count }] };
    saveInventory();
    refreshInventoryViews();
    renderResults();
  });
}



// --- Manual rune entry (no screenshot) -------------------------------

// Tier/Type never change and don't depend on affixState loading, so
// these populate once here rather than every time the dialog opens.
[1, 2, 3, 4, 5].forEach((t) => {
  const opt = document.createElement("option");
  opt.value = t;
  opt.textContent = `Tier ${t}`;
  els.manualTier.appendChild(opt);
});
RUNE_TYPES.forEach((t) => {
  const opt = document.createElement("option");
  opt.value = t;
  opt.textContent = t;
  els.manualType.appendChild(opt);
});
// Tag also doesn't depend on affixState, so it populates once here too.
// Unlike Fortune/Omen (confirmed every rune definitely has both), it's
// genuinely unclear whether every rune has a tag at all - so unlike the
// manual-add dialog's other dropdowns, this one keeps a real "None"
// option rather than forcing a selection.
(() => {
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "None";
  els.manualTagName.appendChild(none);
  TAG_NAMES.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    els.manualTagName.appendChild(opt);
  });
})();

function openManualAddDialog() {
  // Fortune/Omen depend on affixState, which loads asynchronously (see
  // loadAffixes below) - repopulated fresh on every open rather than
  // once at setup, so this is correct whether it's the first click or a
  // later one, without needing to coordinate with that load's timing.
  // Sorted alphabetically (unlike the OCR-review dropdowns, left as-is)
  // since scanning for one specific known name by eye is exactly what
  // this dialog is for. No "Unknown" option here - see affixOptions.
  const fortuneNames = (affixState.data?.fortunes?.map((f) => f.name) || []).sort();
  const omenNames = (affixState.data?.omens?.map((o) => o.name) || []).sort();
  els.manualFortune.innerHTML = affixOptions(fortuneNames, null, false);
  els.manualOmen.innerHTML = affixOptions(omenNames, null, false);
  els.manualTagName.value = "";
  els.manualTagMagnitude.value = "";
  els.manualAddStatus.textContent = "";
  els.manualAddDialog.showModal();
}

els.manualAddOpen.addEventListener("click", openManualAddDialog);
els.manualAddClose.addEventListener("click", () => els.manualAddDialog.close());

els.manualAddSubmit.addEventListener("click", () => {
  const tier = parseInt(els.manualTier.value, 10);
  const type = els.manualType.value;
  const prefix = els.manualFortune.value || null;
  const suffix = els.manualOmen.value || null;
  // If Tag is left on "None", magnitude is forced to null regardless of
  // whatever's sitting in that input - avoids an inconsistent state
  // where a stray number is entered but no tag name is actually chosen.
  const tagName = els.manualTagName.value || null;
  const tagMagnitude = tagName ? parseInt(els.manualTagMagnitude.value, 10) || null : null;

  addToInventory(tier, type, prefix, suffix, tagName, tagMagnitude, 1);
  saveInventory();
  refreshInventoryViews();

  // .textContent, never innerHTML, here - safe regardless of what
  // characters a Fortune/Omen name happens to contain, no escaping
  // needed for this specific assignment.
  //
  // Includes Tier alongside the rest - this dialog deliberately stays
  // open between adds, so a stale Tier selection left over from a
  // previous entry is a real, plausible slip. Echoing back every field
  // that was actually submitted (not just three of the four) is what
  // makes this a genuine check against what was entered vs. what was
  // meant, not just a partial one. Fortune/Omen can no longer come back
  // null from this dialog (see affixOptions' includeUnknown), so unlike
  // the OCR review flow there's no "unknown" case left to account for -
  // Tag is the one field here that CAN still be "None", since that's a
  // real, expected choice for this dropdown specifically.
  const tagSuffix = tagName ? ` (+${tagMagnitude ?? "?"} ${tagName})` : "";
  els.manualAddStatus.textContent =
    `Added: Tier ${tier} ${prefix} ${type} Rune of ${suffix}${tagSuffix}. Fields stay as-is - add another, or close when done.`;
});

async function loadDeckCompositions() {
  try {
    const res = await fetch("deck-compositions.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.deckCompositions = await res.json();
  } catch (err) {
    // Not fatal to the rest of the app - the deck-composition preview
    // simply won't render (deckComposition() already returns null for
    // an unrecognized/missing waystone), same graceful-degradation
    // approach as everything else this app tries to load.
    console.error(err);
  }
}

// --- Init -----------------------------------------------------------------

renderInventory();
loadRecipes();
loadAffixes();
loadDeckCompositions();

# Waystone Forge

**Just want to use it?** → [Open Waystone Forge](https://junkman-artificer.github.io/waystone-forge/) - nothing
to install, no account needed, and nothing you upload ever leaves your own
browser.

Screenshot your in-game rune inventory, and it figures out exactly which
waystones you can build right now - down to which specific rune to reach
for when a few crafts are competing for the same type.

Curious how it works under the hood, or want to run it yourself or
contribute? Keep reading below.

---

**Runs entirely in your browser.** OCR happens locally via
[Tesseract.js](https://github.com/naptha/tesseract.js) (WebAssembly). No
server, no API key, no account, no per-use cost. Your inventory is saved
in `localStorage` on your own device. Uploaded screenshots are never
sent anywhere - every file stays local to your browser tab and is only
read into an `<img>` element for OCR.

Before a selected file is even decoded, it's checked against a 20 MB
size cap and, when the browser reports a type at all, that the type is
actually an image - `accept="image/*"` on the file input is a picker
convenience, not a real gate (nothing stops a file from being selected
another way), so these are the actual checks a bad or oversized file
has to clear.

## Using it

> **Don't open `index.html` by double-clicking it.** That loads the page
> as a `file://` URL, and browsers block both the OCR engine's background
> worker and the `recipes.json` fetch under that protocol - the page will
> look like nothing is happening. Instead, serve the folder locally:
>
> ```
> python3 -m http.server 8000
> ```
>
> then open `http://localhost:8000`. (No Python? `npx serve` works too.)
> If you deploy via GitHub Pages this isn't an issue - it's only local
> double-click-to-open that breaks.

1. Open the page (via a local server, or GitHub Pages once deployed).
2. Screenshot your rune inventory in chunks. Scroll until the last rune
   you captured fully disappears off the top of the screen before the
   next shot, and
   start at the bottom of your list and work upward - the runes are
   typically near the bottom, with only junk items below them (which
   shift around as you sell them), so that edge isn't a reliable
   starting point. Working away from it gives the cleanest run of
   screenshots. Leaving gaps is the one real risk - a missed rune won't
   show up anywhere, and there's no way to know it's gone. Overlap
   isn't: once you hit the end of your list and can't scroll further,
   any duplicate runes get flagged and unchecked automatically, so
   there's nothing to fix beyond confirming the flag was right.
3. Upload your screenshots - select several at once (on mobile, tap
   each photo to multi-select before confirming), or upload them one at
   a time; either way they pool into the same review list rather than
   replacing each other, so there's no need to confirm after every
   single screenshot. Detected rows are shown for review - rows too
   close to the top/bottom edge are unchecked automatically, since
   they may be cut off (you'll capture them fully in the next
   screenshot). Fix any misreads with the dropdowns, then confirm to add
   them to your tracked inventory, which is grouped by tier for
   scanability. Lost track of what's piled up across several uploads and
   want a clean restart instead? **Clear Pending Rows** discards the
   whole review batch without touching your inventory. If something
   lands under the wrong tier (a misread tier header, usually), its Tier
   dropdown on that row moves it - merging into an existing stack there
   if one already exists, rather than overwriting it.

   Would rather skip screenshots entirely for a rune or two? **Add a
   Rune Manually**, above the upload button, opens a small dialog to
   pick Tier/Type/Fortune/Omen directly and add it straight to your
   inventory - no OCR involved, so there's nothing to review or
   confirm. Unlike the OCR review dropdowns, there's no "Unknown"
   option here - you're looking at your own inventory and picking
   exactly what you see, so nothing to correct after the fact, and the
   Fortune/Omen lists are alphabetized for quick scanning. The dialog
   stays open after each add, so adding several in a row (or several
   of the exact same rune) doesn't mean reopening it each time.
4. Rune tiers go from 1 to 5, and you never want to craft a deck using a
   rune above its own tier - it works, but weakens the whole deck. So
   waystones are split into five tabs, one per tier. Each tab is green if
   at least one waystone at that tier is currently buildable, red if
   none are. The same waystones and recipes apply at every tier, using
   that tier's own runes - `recipes.json` only needs a waystone defined
   once, not once per tier.
5. Each tab also has two filter rows before the waystone list: **Fortunes
   to use** and **Omens to avoid**. Both narrow which specific named runes
   the tab's crafting math is allowed to draw from - unchecking a Fortune
   means runes with that Fortune are set aside rather than spent, and
   checking an Omen means runes with that Omen are avoided the same way.
   Runes whose Fortune/Omen couldn't be read (still showing "Unknown")
   are never excluded by either filter, since there's nothing to match
   against. Defaults are every Fortune usable and no Omens avoided -
   **Select All** and **Deselect All** return a tab to that default.
   These filters are per-tier and apply to everything below: row colors,
   suggested quantities, and **Find Combinations**.
6. Within a tab, every waystone in the list is colored the same way -
   green if there's currently enough stock to build it, red if not. Each
   one's quantity box starts pre-filled with the most you could currently
   build, and keeps adjusting live as other waystones get checked and
   claim runes from the shared pool - it only stops auto-adjusting once
   you type into it yourself (clear it back to blank to hand control back
   to the live suggestion). Check a box to commit to that quantity - both
   are required together, either alone doesn't count - and the runes it
   needs get set aside from the running total immediately. A committed
   waystone that fit stays green even after its own runes are spent; it
   won't flip red just because it used them, and its quantity is locked
   in at that point too - it won't keep silently drifting afterward just
   because it was never manually typed. When two committed picks compete
   for the same runes, whichever you checked *first* gets them, in the
   order you actually clicked - not whichever happens to be listed
   higher on the page. Still a fast approximation for live feedback, not
   the rigorous check.
7. Hit **Find Combinations** to run that rigorous check across everything
   you've committed to *in the currently open tab* (respecting
   quantities) - it's scoped to one tier at a time, same as the tabs
   themselves. If your runes can satisfy it all at once, you'll get the
   exact spend per target and what's left
   over. If they can't, you'll be told so rather than getting a silent
   wrong answer.

   Each unit shows every recipe variant your inventory currently
   supports for it as a set of radio options, not just the one the
   solver happened to use - with only one unit requested, the solver
   only ever computes the single route it needs and stops there, so
   without this you'd only ever see whichever route it tried first,
   never that an equally valid alternative existed too. Pick whichever
   variant you'd rather build; a "Don't build this" option is included
   in the same set for skipping a unit entirely.

   These lists stay live, not static - if two units both want a route
   that shares a scarce type, picking that route for one correctly
   removes it as an option everywhere it would no longer fit, and
   brings it back the moment that hold is released (a different
   option gets picked, or the unit is set to skip). Every unit's list
   reflects what every OTHER still-unbuilt unit is currently holding,
   not just what the solver originally assumed.
8. The solver's own pick is selected by default on each unit - hit
   **Build Selected** to actually deduct whichever variant you've
   chosen from your tracked inventory once you've really crafted it
   in-game. This is a nice-to-have for people who want the tracker's
   inventory to stay in sync, not a required step - the app's core
   purpose is the plan itself, not tracking what you already built.
   Switch to "Don't build this" for anything you haven't built yet, or
   plan to build later, before hitting the button.

   The checkbox lives on each individual build, not on the waystone as
   a whole - a quantity of 2 can need two genuinely different recipe
   variants to satisfy jointly (different wildcard resolutions), so you
   might have the runes for one but not the other yet. Checking and
   building them independently reflects that, rather than forcing an
   all-or-nothing choice across a waystone's full quantity.

   Building resolves which *specific* named stack each line actually
   draws from, not just the type - a plain "3× Flower" doesn't say
   which Flower if you own more than one kind. The default is always
   the largest matching stack; a "change" link appears wherever a real
   choice existed (2+ stacks were each individually enough on their
   own), showing a dropdown of the alternatives with their trait tags
   for comparison. When no single stack covers it, it auto-splits
   across stacks (largest first) with no override - a split doesn't
   reduce to a simple either/or choice the way a single-stack swap
   does, so that case doesn't get a manual affordance for now.

   Trait tags are abbreviated from each Fortune/Omen's effect in
   `rune-affixes.json` - Fortunes in `[square brackets]`, Omens in
   `<angle brackets>`. The bracket shape carries the Fortune/Omen
   distinction on its own, not just the blue/rust coloring, so it still
   reads correctly without color. Hover a tag for the full, un-abbreviated
   effect text; the "change" dropdown shows the same tags in plain text
   next to each alternative, so comparing options doesn't require
   hovering each one individually.
9. Once every committed unit has actually been built (hit **Build
   selected** for all of them - nothing left on "Don't build this" and
   nothing still just picked-but-unbuilt), **Download Build Checklist**
   appears. It's a standalone, self-contained HTML file - no server,
   works offline, opens fine on a phone - listing exactly which named
   stack to reach for on each build, so you're not doing that lookup
   again mid-session away from a screen. Requiring an actual Build
   click first (not just a committed pick) is what keeps the checklist
   trustworthy: a radio pick can still flip to a different variant
   right up until Build is clicked, which would make a checklist
   downloaded before that point stale immediately. The one remaining
   risk - using "change" to swap which named stack a build used *after*
   downloading - can't be fully closed, since there's no way to reach
   back into a file already saved to your device; the checklist just
   reflects what was true the moment you downloaded it.

   The checklist has its own checkboxes, its own **Save a Copy**
   button (captures your current checked-off progress into a fresh
   download, in case your browser doesn't persist checkbox state for
   local files - genuinely uncertain across mobile browsers, so this
   is the reliable fallback), and its own **Discard This Checklist**
   button (behind a confirm, and placed well away from the checkboxes
   on purpose). All three live entirely separate from the app's own
   tracked inventory - nothing on that page ever touches your real
   counts here.

Two toggles live in the top-right corner of the page, both persisted
across reloads:

- **Troubleshooting Mode** - shows the raw OCR text on every row (not
  just needs-review ones) and enables the debug panel under the upload
  section. Off by default to keep the normal view clean.
- **Colorblind Mode** - adds a ✓/✗ to each tier tab alongside its
  existing green/red border. Scoped to just the tabs, since that's the
  one place relying on color alone - individual waystone rows already
  have their quantity number as a non-color signal (0 vs. a real number
  says the same thing red/green does), so adding marks there too would
  just be redundant clutter. Off by default for the same reason.

## How rows are parsed

The game's rune list doesn't print a quantity anywhere - each row in your
inventory *is* one rune, and each one has a full name like "Mythic River
Rune of Decay" that can wrap onto a second line. Parsing happens in two
independent phases:

1. **Cluster OCR lines into entries by vertical gap alone.** The gap
   between two lines belonging to the same wrapped name is much smaller
   than the gap before a new entry starts, so a small-gap threshold
   (relative to the screenshot's own typical line height) is enough to
   correctly reassemble a wrapped name - and it stays correct even if the
   game adds more tag lines per entry later, since clustering never looks
   at what the lines say, only where they sit.
2. **Extract fields from each cluster's merged text by content.** The type
   (City/Flower/Mask/etc.) is a keyword match. Prefix and suffix are
   matched against the known Fortune/Omen lists in `rune-affixes.json`
   (see below) rather than guessed generically - that's what correctly
   handles a multi-word name like "Last Rites", and what tells apart a
   genuine unrecognized word from OCR garbage. If a captured word isn't
   in the list, it comes back unmatched rather than displayed as a guess,
   and the review UI offers a dropdown to pick the correct one manually.

A row is flagged "needs review" based on whether its type/prefix/suffix
resolved against known vocabulary - not on Tesseract's raw OCR confidence
score. Junk text around the name (a tag chip, a coin value) gets
discarded regardless of how well it read, so it shouldn't be able to
flag a row that was actually read correctly; a row only needs a second
look when a Fortune or Omen genuinely couldn't be matched.

A needs-review row always shows the raw OCR text it couldn't match
(regardless of Troubleshooting Mode - see below), since it's genuinely
useful context for picking the right dropdown value. When the garbled
text is a confident enough near-miss of a known name, a "Did you mean
X?" button appears next to the relevant dropdown - one click fills it
in. This is a similarity heuristic, not a lookup, and it's deliberately
conservative: it only suggests when either the match is very strong on
its own, or it's a decent match *and* clearly beats every other known
name, since two entirely different real names can coincidentally look
alike to a plain similarity score (e.g. "Abundant" and "Ascendant" score
higher against each other than some genuine garbled matches score
against their correct answer). No suggestion ever replaces the raw
text or the dropdown - it's offered alongside both, and silently omits
itself rather than forcing a low-confidence guess.

A row only counts if it's not too close to the screenshot's top/bottom
edge, since a row cut off there might be missing part of its icon;
clipped rows are excluded by default but still editable before you
confirm.

## How the "clipped row" detection works

Since each row's icon has to be fully visible to count as read, and
Tesseract doesn't tell you where the icon graphic itself sits, clipping
is judged from the entry's own text extent instead: a cluster is flagged
clipped if its top or bottom sits within half a line-height of the
screenshot's edge. This is a heuristic, not pixel-perfect icon detection -
tune `EDGE_MARGIN_RATIO` and `CLUSTER_GAP_RATIO` in `app.js` if you find
entries merging, splitting, or getting flagged clipped incorrectly for
your device's screenshots. Everything is also editable before you
confirm, so a bad read never silently corrupts your tracked counts.

## Contributing recipe data

Recipes live in `recipes.json` and are the main thing this project needs
more of - the seed data only covers what's been screenshotted so far.
The same set of waystones and recipes applies at every tier 1-5 - only
the tier of *rune* used to satisfy them differs, not the recipe itself -
so a waystone is defined here once, with no tier field, and the app
expands it into a copy for each tier automatically when it loads.

```json
{
  "name": "Waystone name as shown in-game",
  "location": "Region name",
  "recipes": [
    { "slots": [["City"], ["Mask"], ["Mask", "Night"]] }
  ]
}
```

- Each item in `slots` is one rune slot in the combination.
- A slot with one type (`["City"]`) is a fixed requirement.
- A slot with multiple types (`["Mask", "Night"]`) is a wildcard - any one
  of those types satisfies it.
- A waystone can have multiple `recipes` if the game offers more than one
  valid combination for it - add each as a separate entry.

PRs adding new waystones or corrections to existing recipes are welcome.
If you're not comfortable with JSON, open an issue with a screenshot of
the recipe tracker and someone can transcribe it.

Every PR touching `recipes.json` or `rune-affixes.json` runs an automated
structural check (`.github/workflows/validate-data.yml`) - it catches
typos and malformed submissions, like an invalid rune type or a missing
required field, before a human even needs to look at the diff. It can't
verify game accuracy, though - whether a recipe is actually correct in
the real game still needs a human reviewer who knows it. A passing check
means the data is well-formed, not that it's true.

## Contributing rune prefixes/suffixes

`rune-affixes.json` holds the known Fortune (prefix) and Omen (suffix)
names - this is what parsing matches against, and what populates the
correction dropdowns in the review UI. It's necessarily incomplete; add
to it as new ones show up in-game:

```json
{ "name": "Bountiful", "effect": "Item Drop Rate", "abbrev": "+ItemRate" }
```

`effect` is a one-line note on what the Fortune/Omen actually does - not
used for OCR matching, but it drives the hover tooltip on the
Fortune/Omen filter chips and is the source `abbrev` gets shortened
from. `abbrev` is a short, bracket-ready tag shown next to a named
stack when resolving which one to build with (see "Build Selected"
above) - keep it distinct from every other `abbrev` in the same list
(Fortunes and Omens are checked separately, since they render with
different bracket shapes), since a near-collision between two
different traits' tags defeats the "tell them apart at a glance"
purpose the tags exist for. Prefer the actual stat's +/- direction
where one clearly applies; drop the sign for a triggered/conditional
effect that isn't a simple increase or decrease (e.g. "Weapon
Reflect" has no clean direction to show).
Names can be multi-word ("Last Rites") - matching handles that natively.

## Known limitations

- The solver currently assumes all selected waystones are the same tier.
- OCR accuracy depends on screenshot clarity - very small text or heavy
  compression will hurt detection rate more than typical.
- No icon-image recognition yet; clipping detection is text-position
  based (see above). A CV-based version (e.g. via OpenCV.js) is a
  reasonable future improvement if the heuristic proves unreliable.

## License

MIT - see `LICENSE`.

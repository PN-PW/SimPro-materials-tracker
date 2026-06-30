// ==UserScript==
// @name SimPro Materials Tracker
// @namespace https://powernaturally.simprosuite.com/
// @version 1.9.4
// @description Track delivery route, tracking number, ETA and status per material allocation on SimPro cost-centre pages. Multi-user with realtime sync, audit log, filter chips, CSV export, bulk ETA, CC-log CSV, and BI progress overlay — backed by Supabase.
// @author PowerNaturally
// @match https://powernaturally.simprosuite.com/staff/editCostCentre.php*
// @match https://powernaturally.simprosuite.com/staff/editProject.php*
// @match https://reportbuilder.simprosuite.com/question/*
// @updateURL https://raw.githubusercontent.com/PN-PW/SimPro-materials-tracker/master/userscripts/simpro-materials-tracker.user.js
// @downloadURL https://raw.githubusercontent.com/PN-PW/SimPro-materials-tracker/master/userscripts/simpro-materials-tracker.user.js
// @require https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.js
// @grant GM_addStyle
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_deleteValue
// @grant GM_xmlhttpRequest
// @connect gspkrnqjzabcrufgitdk.supabase.co
// @run-at document-idle
// ==/UserScript==

/* global supabase, GM_addStyle, GM_getValue, GM_setValue, GM_deleteValue, GM_xmlhttpRequest */

// ─── v1.9.4 changelog ─────────────────────────────────────────────────────
// STYLE — Removed all 571 remaining multi-space alignment patterns (object
// literals, CSS strings, inline code). v1.9.3 only caught spaces before `=`;
// this pass covers every other position. No functional change.
//
// ─── v1.9.3 changelog ─────────────────────────────────────────────────────
// STYLE — Removed 47 multi-space-before-= alignment patterns throughout the
// script. Tampermonkey's linter (no-multi-spaces rule) flagged these as
// warnings on every install. No functional change.
//
// ─── v1.9.2 changelog ─────────────────────────────────────────────────────
// BUG FIX — "currentStockTab is not defined" + row checkboxes gone.
//
// Root cause:
// currentStockTab was declared with `let` inside injectBulkBar() (IIFE-level
// function), but syncAllocatedView() is defined inside bootstrapCostCentreEdit()
// — a different scope chain. In strict mode, the assignment
// `currentStockTab = ...` in syncAllocatedView threw ReferenceError because
// the variable was not visible through its scope chain. The function aborted
// before table.classList.toggle('mt-allocated-active', ...) could run, so the
// CSS guard permanently hid all .mt-check cells → checkboxes disappeared.
//
// Fix:
// Moved `let currentStockTab = 'All'` to the IIFE level (alongside
// currentUser / currentUserRole) where both injectBulkBar's applyFilter
// closure and syncAllocatedView can reach it through the scope chain.
// Removed the shadowing declaration from inside injectBulkBar.
//
// ─── v1.9.1 changelog ─────────────────────────────────────────────────────
// BUG FIX — Allocated tab showed ALL material rows, not just formally-assigned ones.
//
// Root cause:
// applyFilter() used `display:table-row !important` on every injected row
// whenever the Allocated tab was active — regardless of whether SimPro had
// actually allocated that row (AllocatedStock CSS class). For a fresh job
// (nothing drawn from stock yet) SimPro's Allocated tab is correctly empty,
// but our script was overriding SimPro's `.hide` filter and force-showing all
// 10 rows there, with Assigned = 0 [0] for every line. This also meant two
// users on the same job could appear to see different data depending on which
// tab they had open.
//
// Fix A — Allocated tab row visibility (applyFilter):
// On the Allocated tab, only rows that carry SimPro's `AllocatedStock` CSS
// class are force-shown (these are materials SimPro has formally drawn from
// stock for the job). All other rows get `removeProperty('display')` so
// SimPro's `.hide` class hides them correctly. The Allocated tab now shows
// exactly what SimPro says is allocated — nothing more.
//
// Fix B — MT columns on All tab (syncAllocatedView):
// Because the Allocated tab is empty for fresh jobs, users need another tab
// where MT controls are accessible. MT columns + bulk bar are now shown on
// both the Allocated tab AND the All tab (`isMtActive` flag). Required /
// In Stock / Order tabs remain uncluttered (MT columns hidden).
//
// Fix C — Unified stripe logic (syncAllocatedView):
// The previous code had separate stripe paths for Allocated vs. other tabs.
// All tab switches now use the same clear-then-recount-visible pattern with
// setTimeout(0), which correctly handles any tab (including Allocated when
// only a subset of rows are visible).
//
// ─── v1.9.0 changelog ─────────────────────────────────────────────────────
// BUG FIX — MT cells locked on ALL rows for jobs with no stock assigned yet.
//
// Root cause (browser-verified on job #5770):
// The mt-unassigned check used only the assignment spinner value
// (stockInput.value = 0) to decide whether to gray-out MT cells. For a
// fresh job where no stock has been formally drawn yet, EVERY row has
// stockInput.value = 0 — so every row was locked, making the tracker
// completely unusable until someone ran the SimPro "Assign from Stock" step.
//
// Browser inspection confirmed:
// • 10 injected rows, all with In Stock > 0 (e.g. "2 [0]" at cells[9])
// • 0 rows with stockInput.value > 0 (nothing formally assigned)
// • 10/10 rows wrongly marked mt-unassigned → all MT cells grayed/disabled
// • No row carried an "AllocatedStock" CSS class — SimPro's Allocated tab
// is semantically empty for this job; rows only had AllStock + RequiredStock
//
// Fix: parseAllocationRows now reads cells[9] ("In Stock" column) to extract
// in_stock_qty for main rows. injectRowCells uses the dual condition:
// unassigned = !assigned_qty && !in_stock_qty
// A row with stock available at its location (In Stock > 0) is NEVER locked,
// even if nothing has been formally drawn yet. Only rows with genuinely
// nothing to track (In Stock = 0 AND Assigned = 0) are grayed out.
// recheckAssignedState (v1.8.9 timing fix) mirrors the same condition.
//
// ─── v1.8.9 changelog ─────────────────────────────────────────────────────
// BUG FIX — multi-user: one user sees MT cells locked (grayed-out), the
// other sees them working correctly on the same job at the same time.
//
// Root cause: parseAllocationRows reads stockInput.value SYNCHRONOUSLY at
// script start (document-idle). SimPro sometimes sets stock input values
// via its own JavaScript AFTER document-idle fires, creating a race. If
// our script wins the race it reads 0, marks every row mt-unassigned, and
// injects grayed-out, non-interactive MT cells. The other user's browser
// loses the race (SimPro's JS ran first) and gets the real values.
//
// Fix 1 — Post-injection re-check: after all rows are injected, re-read
// each stockInput.value at 300 ms and 1500 ms. If a value has changed
// from 0 → non-zero (SimPro populated it after our initial parse), the
// mt-unassigned class is lifted and the MT controls are re-enabled.
//
// Fix 2 — ensureRecords guard: the same timing artefact caused ensureRecords
// to write assigned_qty=null back to Supabase when stored.assigned_qty was
// a real non-zero value, silently corrupting the BI progress denominator.
// ensureRecords now only propagates an assigned_qty change when the DOM
// value is non-null; a null/zero DOM value never overwrites a real stored
// value.
//
// ─── v1.8.7 changelog ─────────────────────────────────────────────────────
// BUG FIX — v1.8.6 chess-board on Allocated tab + no improvement elsewhere:
// Two separate bugs:
// 1. CSS specificity: the stripe rule had `tbody tr` in the selector, giving
// it extra element selectors and pushing its specificity above the tier-
// colour rules — status cell tier colours were lost on Allocated tab.
// Fix: remove `tbody tr` from selector → (0,1,2,1), same as tier rules.
// Equal !important specificity → last-declared wins → tier wins. ✓
// 2. Re-apply counter: syncAllocatedView re-applied with si=1,2,3… but only
// iterated [data-mt-injected="1"] rows. Non-injected rows (no tracking
// record) still consumed stripe positions during the initial injection, so
// the counter produced wrong odd/even assignments for injected rows → chess
// board. Fix: read mt-row-odd/even CLASS set during injection — no counter.
// 3. Clear scope: clear only targeted injected rows; non-injected rows kept
// their inline style and still showed wrong colours on non-Allocated tabs.
// Fix: clear uses tr:is(.mt-row-odd,.mt-row-even) to cover all striped rows.
//
// ─── v1.8.6 changelog ─────────────────────────────────────────────────────
// BUG FIX — v1.8.5 broke Allocated tab (status tier colours lost, wrong
// stripe colours) while not improving other tabs:
// The CSS rule was scoped to .mt-allocated-active but still targeted all
// `> td`, giving it higher specificity than the status-tier CSS rules — so
// stripe colour stomped the tier colour on the status column. The re-apply
// loop also touched MT-injected TDs (.mt-cell, .mt-check) which have their
// own colour rules and should never receive an inline stripe override.
// Fix: both the CSS selector and the JS re-apply / clear loops now exclude
// .mt-cell and .mt-check elements. Native SimPro TDs get the inline stripe
// on the Allocated tab (and lose it on other tabs); MT-injected cells keep
// their CSS-based colours untouched on all tabs.
//
// ─── v1.8.5 changelog ─────────────────────────────────────────────────────
// BUG FIX — inconsistent row striping on Required / All / In Stock / Order:
// Our script applies inline background-color !important to every TD during
// injection, based on each row's DOM position across ALL rows. On the
// Allocated tab this is correct. On other tabs SimPro hides rows (Needed=0
// etc.) but hidden rows still consume stripe positions, so visible rows can
// end up all the same colour.
// Fix: syncAllocatedView now clears inline background-color from all MT TDs
// when switching to a non-Allocated tab, and re-applies them on return.
// The CSS striping rule is scoped to #materialsTable.mt-allocated-active so
// SimPro's own alternating colours take effect on all other tabs.
// reinjectAfterRefresh also calls syncAllocatedView() (was filterApi.reapply)
// so a SimPro partial re-render on a non-Allocated tab doesn't restore the
// stale inline colours.
//
// ─── v1.8.4 changelog ─────────────────────────────────────────────────────
// BUG FIX — Required/All/In Stock/Order tabs showed rows that SimPro
// had hidden (e.g. Needed = 0 on the Required tab):
// applyFilter() used `display:table-row !important` to fight SimPro's
// autosave `.hide` re-additions on the Allocated tab. That same override
// also fired on non-Allocated tabs, stomping SimPro's legitimate row-hiding.
// Fix: applyFilter now checks `mt-allocated-active` on the table and only
// forces display on the Allocated tab; on other tabs it removes the override
// so SimPro's native tab filtering works normally.
// syncAllocatedView now calls filterApi.reapply() immediately on tab switch
// so the cleanup happens synchronously rather than waiting for the next
// MutationObserver event.
//
// ─── v1.8.3 changelog ─────────────────────────────────────────────────────
// • Added @updateURL and @downloadURL headers pointing to the public GitHub
// raw URL so Tampermonkey auto-updates when the repo is public.
// • Fixed checkbox header (`th.mt-check`) not being hidden on non-Allocated
// stock sub-tabs (Required, All, In Stock, Order). The CSS guard rule now
// includes `th.mt-check` alongside `th.mt-col-head`.
//
// ─── v1.8.0 changelog ─────────────────────────────────────────────────────
// • Route: SU_WH_ST (Supplier → Warehouse → Site) renamed to SU_WH
// (Supplier → Warehouse). The site-delivery leg is now tracked separately
// under the WH_ST route. Requires SQL migration:
// ALTER TYPE delivery_route ADD VALUE IF NOT EXISTS 'SU_WH' AFTER 'SU_WH_ST';
// UPDATE tracking_records SET route = 'SU_WH' WHERE route = 'SU_WH_ST';
// • New status: "Delivered to WH" (value: delivered_wh, tier 3, weight 70%).
// Sits between Shipped (60%) and Delivered to site (80%). Appears in the
// Transit filter chip. Requires SQL migration:
// ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'delivered_wh' AFTER 'shipped';
// • Status rename: "Delivered" → "Delivered to site" (DB value unchanged:
// 'delivered'). No data migration required.
// • Progress weight scale updated:
// Shipped / Collected 60% → Delivered to WH 70% → Delivered to site 80%
//
// ─── v1.7.9 changelog ─────────────────────────────────────────────────────
// BUG FIX — BI progress % diverges from CC page progress bar:
// ensureRecords() only ever inserted NEW rows into Supabase; it never updated
// assigned_qty / required_qty for rows that already existed. If SimPro later
// changed an allocation (more stock added, or materials unassigned), Supabase
// kept the old qty values. The CC page uses SimPro's live DOM to decide which
// rows count as "assigned" (the mt-unassigned class), so it was always correct.
// The BI page used the stale Supabase assigned_qty, producing a different
// denominator and a wrong percentage.
// Fix: ensureRecords() now detects rows where assigned_qty or required_qty
// differs between SimPro's current DOM and the stored DB value, and fires a
// batch of UPDATE calls to bring Supabase in sync. This runs on every CC page
// visit and is effectively a no-op (0 updates) when nothing has changed.
//
// ─── v1.7.8 changelog ─────────────────────────────────────────────────────
// • BI header tracking: replaced one-shot resize listener with a
// requestAnimationFrame IIFE (trackPosition) that polls getBoundingClientRect
// every frame, keeping the header overlay pixel-perfect when Metabase panels
// toggle or the viewport shifts — not just on window resize.
// • BI filter visual: non-matching rows now get a full-width rgba overlay strip
// (rowDimPool) spanning the entire data grid, instead of only dimming the 90 px
// progress cell — makes filtered-out rows clearly visible at a glance.
// • BI filter count badge: clicking a filter option now shows the count of
// matching rows across ALL 3,521 rows in the header, e.g. "Prog: Has data (6)".
// • Route column: labels shortened to WH→ST / SUP→ST / SUP→WH→ST / VAN→ST;
// column width increased 95px → 115px so the longest label fits.
// • Route tooltip: hovering the select or any option shows the full description
// (e.g. "Supplier → Warehouse → Site") via the title attribute.
//
// ─── v1.7.5 changelog ─────────────────────────────────────────────────────
// • BI page: increase results-grid waitFor timeout from 20 s to 90 s.
// The Metabase question executes a live DB query returning 3,521 rows;
// this routinely takes > 20 s before React renders any DOM content.
// A heartbeat log every 10 s confirms the script is still waiting, and
// the failure message now includes body HTML length for diagnosis.
//
// ─── v1.7.4 changelog ─────────────────────────────────────────────────────
// • BI page: fix CSP-blocked auth. initClient() creates a Supabase JS client
// with autoRefreshToken:true, which immediately fires _recoverAndRefresh()
// using fetch() — blocked by Metabase's connect-src CSP. bootstrapBIPage
// no longer calls initClient() or sb.auth.getSession(). Instead it reads
// the raw session JSON directly from GM_getValue('mt-auth') (no network)
// and refreshes the token via GM_xmlhttpRequest if it is expiring (<60 s).
// All subsequent calls were already using GM_xmlhttpRequest. This removes
// the flood of "Refused to connect" CSP errors and allows getSession to
// succeed reliably.
//
// ─── v1.7.3 changelog ─────────────────────────────────────────────────────
// • BI page: Metabase's Content Security Policy blocks all direct fetch()
// calls to Supabase (connect-src does not whitelist gspkrnqjzabcrufgitdk.
// supabase.co). Fixed by routing the Supabase data query through
// GM_xmlhttpRequest, which runs in Tampermonkey's extension context and is
// fully CSP-exempt. Added @grant GM_xmlhttpRequest and @connect.
// • BI page: skip loadCurrentUserRole() (also CSP-blocked, not needed on BI
// page) and read the JWT directly from the GM-stored session instead of
// going through ensureAuth's interactive flow.
//
// ─── v1.7.2 changelog ─────────────────────────────────────────────────────
// • BI page: rewrote table detection with an adapter pattern that handles
// BOTH classic <table> markup and Metabase's div-based ARIA grid
// (role="columnheader" / role="gridcell"). Previous version only searched
// for <table> elements — Metabase's newer virtual-scroll renderer uses divs
// so the column was never injected. Detailed console diagnostics are logged
// under [MT] so failures are easy to report.
//
// ─── v1.7.1 changelog ─────────────────────────────────────────────────────
// • Auth shared across domains: Supabase session now stored in Tampermonkey
// GM storage (not window.localStorage) so sign-in on a SimPro cost-centre
// page is automatically available on the BI page (different hostname).
// • Chip counts no longer inflate with qty=0 (unassigned) rows — those rows
// have no meaningful tracking state and were confusingly appearing in "All"
// and "Pending" badges.
// • CC Log CSV now includes a UTF-8 BOM so Excel opens it without garbling
// em dashes (—), arrows (→) and other non-ASCII characters.
// • Info button now calls e.preventDefault() in addition to stopPropagation()
// to prevent SimPro's form handlers from wiping the page when the modal is
// opened via the ⓘ button.
// • Bulk bar re-injection: if SimPro replaces the entire table container
// (not just the tbody), the bulk bar was permanently lost. reinjectAfterRefresh
// now detects a disconnected bar and re-injects it into the new container.
// • BI page: allow interactive sign-in prompt if session is not yet available
// on that domain.
//
// ─── v1.7.0 changelog ─────────────────────────────────────────────────────
// • Admin delete now RE-SEEDS the row: after erasing the old tracking record
// a fresh "Not actioned" record is immediately inserted so the row stays
// fully interactive — no more broken/missing MT columns after a delete.
// • CC Log CSV download: "Download CSV" button added to the CC Log modal.
// Flat layout — DateTime | User | Material | Location | Field | Old | New.
// • BI page overlay: adds @match for reportbuilder.simprosuite.com/question/*
// and injects a live "Progress %" column into the Metabase results table,
// computing weighted progress from Supabase tracking_records per CC.
//
// ─── v1.6.3 changelog ─────────────────────────────────────────────────────
// BUG FIX — sub-row column misalignment (personal stock / non-warehouse):
// Sub-rows (PN_Darren H. Stock etc.) use colspan=8 on their second TD to
// skip the Name→Value columns, giving them only ~8 native TDs vs ~15 for
// main rows. INSERT_AFTER_IDX=11 is out of range so cells were appended to
// the end, landing on wrong visual columns (Route in Status column, etc.).
// • injectRowCells now detects sub-rows (cells.length < 10 after checkbox)
// and inserts before cells[5] (the stock-location link) instead of
// cells[12], placing MT columns at effective col 12-16 for both row types
// and correctly pushing the stock link/spinner to the Move-Diff/Assigned
// column positions.
//
// ─── v1.6.2 changelog ─────────────────────────────────────────────────────
// ROOT CAUSE FIX — rows disappear after every save / ETA pick:
// SimPro's autosave sets `display:table-row` (inline, no !important) on
// the visible tab rows. Our old `removeProperty('display')` stripped THAT
// inline style, letting the `.hide { display:none }` stylesheet rule win.
// • applyFilter now uses `display:table-row !important` for shown rows,
// overriding both the `hide` CSS class AND SimPro's own non-important
// inline style — rows we decide to show are ALWAYS visible.
// • MutationObserver extended to watch class-attribute changes on <tr>
// elements so a `hide`-class toggle also triggers a filter re-apply.
// • reinjectAfterRefresh always calls filterApi.reapply() after any DOM
// mutation, not just after a full re-injection.
// • 1.5 s fallback poll: if SimPro replaces the <tbody> element itself
// (the observer loses its reference), the poll detects the lost injection
// within 1.5 s and re-injects without needing a page reload.
//
// ─── v1.6.1 changelog ─────────────────────────────────────────────────────
// • MutationObserver resilience: when SimPro's timer-based autosave AJAX-
// refreshes the materials tbody (wiping our injected cells), the observer
// detects the pattern and re-injects all tracker controls automatically —
// no page reload required.
//
// ─── v1.6.0 changelog ─────────────────────────────────────────────────────
// • Bulk ETA on the bulk bar — pick a date + Apply, or tick "Clear ETA" to
// null out the ETA on every selected row.
// • CSV export only includes rows currently rendered in the SimPro table
// (orphan tracking_records — for materials unassigned in SimPro after
// they were first seeded — used to surface as empty-material lines).
// "Material Code" column dropped from CSV (the script never populated it).
// • Filter-chip counts ("All / Pending / In transit / …") now count only
// ON-PAGE records — orphans don't inflate the badges any more.
// • Filter `display: none` now uses `setProperty(…, 'important')` so SimPro
// stylesheet rules can't override it — fixes "filtering does not filter".
// • Per-row Route / Status / ETA change events have `stopPropagation()` so
// SimPro's delegated form handlers never see them — fixes "all materials
// disappear when I pick a date in the ETA column" (SimPro was treating
// the bubbled change as one of its native date fields and partial-rendering
// the materials table, which wiped our injected cells).
// • applyFilter now treats a missing record as "show" rather than "hide" —
// defensive guard against transient cache races during realtime echoes.
// ──────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // 0. LOAD GUARD — fail loudly if @require didn't pull Supabase
  // ═══════════════════════════════════════════════════════════════════════════
  if (typeof supabase === 'undefined' || !supabase?.createClient) {
    console.error('[MT] Supabase library failed to load via @require. Tampermonkey → Materials Tracker → Externals → update the supabase.js resource, then reload.');
    const warnBar = document.createElement('div');
    warnBar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#c9302c;color:#fff;padding:8px 14px;font:13px/1.4 Roboto,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    warnBar.textContent = 'Materials Tracker: Supabase library didn\u2019t load. Open Tampermonkey \u2192 Materials Tracker \u2192 Externals, update the supabase.js resource, then reload this page.';
    (document.body || document.documentElement).appendChild(warnBar);
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. CONFIG
  // ═══════════════════════════════════════════════════════════════════════════
  const SUPABASE_URL = 'https://gspkrnqjzabcrufgitdk.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdzcGtybnFqemFiY3J1ZmdpdGRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NDM3NzgsImV4cCI6MjA5MjAxOTc3OH0.dhVgfAeLs9ffvxRx3fZtwlfR_CyW6xajglEJMahGQAo';

  const LOG = '[MT]';
  const log = (...a) => console.log(LOG, ...a);
  const warn = (...a) => console.warn(LOG, ...a);
  const err = (...a) => console.error(LOG, ...a);

  const ROUTES = [
    { value: 'WH_ST', label: 'WH→ST', title: 'Warehouse → Site' },
    { value: 'SU_ST', label: 'SUP→ST', title: 'Supplier → Site' },
    { value: 'SU_WH', label: 'SUP→WH', title: 'Supplier → Warehouse' },
    { value: 'VAN_ST', label: 'VAN→ST', title: 'Van Stock → Site' },
  ];
  // Statuses + their progress "tier" (purely visual — the 100% metric is receipt_confirmed only).
  // tier 0 = neutral (grey), 1 = early (amber), 2 = in-transit (blue),
  // 3 = delivered (light green), 4 = done (dark green), 9 = bad (red)
  const STATUSES = [
    { value: 'not_actioned', label: 'Not actioned', tier: 0 },
    { value: 'ordered', label: 'Ordered', tier: 1 },
    { value: 'confirmed', label: 'Confirmed', tier: 1 },
    { value: 'shipped', label: 'Shipped', tier: 2 },
    { value: 'collected_engineer', label: 'Collected by engineer',tier: 2 },
    { value: 'collected_customer', label: 'Collected by customer',tier: 2 },
    { value: 'delivered_wh', label: 'Delivered to WH', tier: 3 },
    { value: 'delivered', label: 'Delivered to site', tier: 3 },
    { value: 'receipt_confirmed', label: 'Receipt confirmed', tier: 4 },
    { value: 'issue', label: 'Issue', tier: 9 },
    { value: 'returned', label: 'Returned', tier: 9 },
  ];
  const STATUS_BY_VALUE = Object.fromEntries(STATUSES.map(s => [s.value, s]));

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. STYLES — tuned to match SimPro (Roboto, rgb(35,42,47), white BG, blue #3071a9).
  // ═══════════════════════════════════════════════════════════════════════════
  GM_addStyle(`
    /* ── Allocated-tab guard — hide MT columns on all other stock sub-tabs ── */
    #materialsTable:not(.mt-allocated-active) td.mt-cell,
    #materialsTable:not(.mt-allocated-active) td.mt-check,
    #materialsTable:not(.mt-allocated-active) th.mt-col-head,
    #materialsTable:not(.mt-allocated-active) th.mt-check { display: none !important; }

    /* ── Table column cells ──────────────────────────────────────────────── */
    #materialsTable td.mt-cell {
      font-family: Roboto, sans-serif;
      color: rgb(35, 42, 47);
      border-left: 1px solid #e1e6eb;
      border-right: 1px solid #e1e6eb;
      padding: 2px 4px;
      vertical-align: middle;
      background: transparent; /* inherit from row so we blend */
    }
    /* Header cells deliberately inherit font/colour from SimPro's native <th>
       so "Route / Tracking No. / Status / Info" look identical to the built-in
       "Name / Required / Assigned / …" labels next to them. Only structural
       styling (border, padding, background) is overridden here. */
    #materialsTable th.mt-col-head {
      border-left: 1px solid #e1e6eb;
      border-right: 1px solid #e1e6eb;
      background: #fff !important; /* match SimPro's native white headers */
      white-space: nowrap;
      padding: 4px 6px;
      vertical-align: middle;
    }
    /* Row striping — Allocated tab only.
       Specificity (0,1,2,1) is deliberately equal to the status-tier rules
       declared ~100 lines below. Equal !important specificity → last-declared
       wins, so tier colours always beat stripe on the status cell. Applies to
       all direct-child td (including MT cells) so the whole row is uniform;
       native TDs also receive inline !important via JS to beat SimPro's own
       occasional inline overrides. syncAllocatedView removes those inline
       overrides when leaving Allocated so SimPro's colours take over. */
    #materialsTable.mt-allocated-active .mt-row-even > td { background: #ffffff !important; }
    #materialsTable.mt-allocated-active .mt-row-odd > td { background: #eef2f7 !important; }
    /* Fixed widths so dropdowns never overlap.
       v1.6.4: reduced from 608px → 479px; v1.6.4b: 479px → 412px.
       The header labels also drive minimum column width (white-space:nowrap),
       so "Track No." and "ℹ" were shortened to let those columns go narrow. */
    #materialsTable th.mt-col-route, #materialsTable td.mt-route-cell { width: 115px; }
    #materialsTable th.mt-col-track, #materialsTable td.mt-track-cell { width: 85px; }
    #materialsTable th.mt-col-eta, #materialsTable td.mt-eta-cell { width: 100px; }
    #materialsTable th.mt-col-status, #materialsTable td.mt-status-cell { width: 110px; }
    #materialsTable th.mt-col-info, #materialsTable td.mt-info-cell { width: 22px; text-align: center; }
    /* Prevent select elements from overflowing their column — width:100% fills
       the TD but max-width:100% stops the select's intrinsic min-width from
       pushing the column wider in table-layout:auto. */
    #materialsTable td.mt-route-cell select,
    #materialsTable td.mt-status-cell select { max-width: 100%; }
    /* Tracking cell holds an input + a copy button side-by-side */
    #materialsTable td.mt-track-cell .mt-track-wrap {
      display: flex; align-items: center; gap: 4px;
    }
    #materialsTable td.mt-track-cell .mt-track-wrap .mt-track { flex: 1 1 auto; min-width: 0; }
    #materialsTable .mt-track-copy {
      flex: 0 0 auto;
      width: 22px; height: 22px; padding: 0;
      border: 1px solid #c5ced8; border-radius: 3px;
      background: #fff; color: #3071a9; cursor: pointer;
      font-size: 13px; line-height: 1;
      font-family: Roboto, sans-serif;
    }
    #materialsTable .mt-track-copy:hover { background: #e7f0f8; border-color: #3071a9; }
    #materialsTable .mt-track-copy:disabled { opacity: 0.3; cursor: not-allowed; }
    /* ETA — small date input. Kept native so iOS / Android get their own pickers. */
    #materialsTable input.mt-eta {
      width: 100%; box-sizing: border-box;
      font-size: 12px; padding: 2px 4px;
      border: 1px solid #c5ced8; border-radius: 2px;
      background: #fff; font-family: Roboto, sans-serif;
    }
    #materialsTable input.mt-eta.mt-eta-overdue {
      border-color: #c9302c; background: #fdecea; color: #9c2420; font-weight: 600;
    }
    #materialsTable input.mt-eta.mt-eta-soon {
      border-color: #f0ad4e; background: #fff4e0; color: #8a5a00;
    }
    #materialsTable .mt-select,
    #materialsTable .mt-track {
      width: 100%;
      box-sizing: border-box;
      font-size: 12px;
      padding: 2px 4px;
      border: 1px solid #c5ced8;
      border-radius: 2px;
      background: #fff;
      font-family: Roboto, sans-serif;
    }
    /* Leading checkbox column — header matches theme white, body transparent */
    #materialsTable td.mt-check {
      width: 24px;
      padding: 2px 0 2px 6px;
      text-align: center;
      border-right: 1px solid #e1e6eb;
      background: transparent;
    }
    #materialsTable th.mt-check {
      width: 24px;
      padding: 2px 0 2px 6px;
      text-align: center;
      border-right: 1px solid #e1e6eb;
      background: #fff !important;
    }
    /* Per-row tracking input is display-only — editing happens only in the bulk bar */
    #materialsTable input.mt-track[readonly] {
      background: #f7fafc;
      color: #697783;
      cursor: default;
      font-style: italic;
    }
    #materialsTable input.mt-track[readonly]:hover {
      border-color: #c5ced8; /* don't pulse on hover */
    }
    /* Per-row save feedback.
       We DON'T paint the whole row any more — that fought the status tier
       colour (yellow dirty vs. pink "issue" looked almost identical) and a
       stale dirty class left the row permanently coloured. Instead we put a
       thin stripe on the left edge of the checkbox cell — never overlaps the
       status cell, so the tier colour always shows through. */
    #materialsTable tr.mt-dirty > td.mt-check {
      box-shadow: inset 4px 0 0 #f0ad4e; /* amber while saving */
    }
    #materialsTable tr.mt-saved > td.mt-check {
      box-shadow: inset 4px 0 0 #5cb85c; /* green flash on success */
      transition: box-shadow 0.8s;
    }
    #materialsTable tr.mt-error > td.mt-check {
      box-shadow: inset 4px 0 0 #c9302c; /* red on save failure */
    }
    /* ── Zero-assigned rows: MT controls locked ──────────────────────────────
       When assigned_qty = 0 (nothing has been pulled from stock yet) the row
       gets the mt-unassigned class. Every MT cell is dimmed and made
       non-interactive — there's nothing to track until stock is assigned.
       The !important on background beats both odd/even striping and tier
       colour rules so the graying is unmistakably visible. */
    #materialsTable tr.mt-unassigned td.mt-cell {
      opacity: 0.3;
      pointer-events: none;
      background: #e8e8e8 !important;
    }
    #materialsTable tr.mt-unassigned td.mt-check {
      opacity: 0.3;
      pointer-events: none;
    }

    /* ── Status semantic colours ─────────────────────────────────────────── */
    /* IMPORTANT: tier rules must outweigh the base #materialsTable rule, so
       we prefix them with the same ID to lift specificity above 0,1,1,1. */
    #materialsTable select.mt-status { border-left: 4px solid transparent; }
    #materialsTable select.mt-status.mt-tier-0 { background: #ffffff; border-left-color: #9aa5b1; color: #4a5560; }
    #materialsTable select.mt-status.mt-tier-1 { background: #fff4e0; border-left-color: #f0ad4e; color: #8a5a00; font-weight: 600; }
    #materialsTable select.mt-status.mt-tier-2 { background: #e7f3fa; border-left-color: #31b0d5; color: #1d5f7a; font-weight: 600; }
    #materialsTable select.mt-status.mt-tier-3 { background: #e7f6e7; border-left-color: #5cb85c; color: #1e6a1e; font-weight: 600; }
    #materialsTable select.mt-status.mt-tier-4 { background: #c9edca; border-left-color: #2b8a3e; color: #134d13; font-weight: 700; }
    #materialsTable select.mt-status.mt-tier-9 { background: #fdecea; border-left-color: #c9302c; color: #9c2420; font-weight: 700; }
    /* Colour bleeds into the TD too so the cell is obvious at a glance */
    #materialsTable td.mt-status-cell.mt-cell-tier-1 { background: #fff4e0 !important; }
    #materialsTable td.mt-status-cell.mt-cell-tier-2 { background: #e7f3fa !important; }
    #materialsTable td.mt-status-cell.mt-cell-tier-3 { background: #e7f6e7 !important; }
    #materialsTable td.mt-status-cell.mt-cell-tier-4 { background: #c9edca !important; }
    #materialsTable td.mt-status-cell.mt-cell-tier-9 { background: #fdecea !important; }

    /* ── Bulk bar — compact, SimPro-styled ─────────────────────────────────
       Two-row layout so the "Apply to Selected" button always pins to the
       right of row 1, regardless of how wide the Status dropdown renders
       its current selection. Row 2 carries progress + user info. */
    .mt-bulk-bar {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 10px;
      margin: 6px 0;
      background: #f2f5f8;
      border: 1px solid #d6dde4;
      border-radius: 3px;
      font: 12px/1.4 Roboto, sans-serif;
      color: rgb(35, 42, 47);
    }
    .mt-bulk-bar .mt-bar-row {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    /* Top row must never wrap — Apply to Selected is pinned right of a spacer
       and MUST stay on the same line no matter which Status label is shown.
       Each control has a fixed width so the bar doesn't reflow when the user
       picks "Collected by customer" (wide text) vs "Ordered" (narrow text). */
    .mt-bulk-bar .mt-bar-row-top {
      flex-wrap: nowrap;
      min-width: 0;
      overflow-x: auto; /* very narrow viewports scroll horizontally
                                  rather than pushing the Apply button off-row */
    }
    .mt-bulk-bar .mt-bar-row-bottom {
      border-top: 1px dashed #d6dde4;
      padding-top: 4px;
      margin-top: 2px;
    }
    .mt-bulk-bar .mt-refresh-hint {
      color: #8a5a00; background: #fff4e0; border: 1px solid #f0ad4e;
      padding: 1px 8px; border-radius: 3px; font-size: 11px; font-weight: 600;
    }
    .mt-bulk-bar .mt-role {
      padding: 1px 6px; border-radius: 8px; font-weight: 700; text-transform: uppercase;
      font-size: 10px; letter-spacing: 0.5px; margin-right: 4px;
    }
    .mt-bulk-bar .mt-role.mt-role-admin { background: #24476b; color: #fff; }
    .mt-bulk-bar .mt-role.mt-role-editor { background: #3071a9; color: #fff; }
    .mt-bulk-bar .mt-role.mt-role-readonly { background: #9aa5b1; color: #fff; }
    .mt-bulk-bar .mt-admin-btn {
      padding: 2px 8px; background: #24476b; color: #fff;
      border: 1px solid #17324f; border-radius: 2px; cursor: pointer;
      font-size: 11px; font-weight: 600;
    }
    .mt-bulk-bar .mt-admin-btn:hover { background: #17324f; }
    /* Readonly mode — visually dampen editable controls */
    .mt-bulk-bar[data-mt-readonly="1"] .mt-bulk-route,
    .mt-bulk-bar[data-mt-readonly="1"] .mt-bulk-status,
    .mt-bulk-bar[data-mt-readonly="1"] .mt-bulk-track,
    .mt-bulk-bar[data-mt-readonly="1"] .mt-bulk-btn {
      opacity: 0.5; pointer-events: none;
    }
    .mt-readonly-banner {
      padding: 4px 10px; background: #e7f0f8; color: #24476b;
      border: 1px solid #c5d5e6; border-radius: 3px; font-size: 11px;
      font-weight: 600;
    }
    .mt-bulk-bar .mt-bulk-group { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; flex: 0 0 auto; }
    .mt-bulk-bar label { margin: 0; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; white-space: nowrap; flex: 0 0 auto; }
    /* Filter chips — toggleable pills in the top row */
    .mt-bulk-bar .mt-filter-chips { display: inline-flex; gap: 4px; flex: 0 0 auto; }
    .mt-bulk-bar .mt-chip {
      padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;
      border: 1px solid #c5ced8; background: #fff; color: #4a5560; cursor: pointer;
      font-family: Roboto, sans-serif; white-space: nowrap;
    }
    .mt-bulk-bar .mt-chip:hover { background: #e7f0f8; }
    .mt-bulk-bar .mt-chip.mt-chip-active {
      background: #24476b; color: #fff; border-color: #17324f;
    }
    .mt-bulk-bar .mt-chip.mt-chip-issue.mt-chip-active { background: #c9302c; border-color: #9c2420; }
    .mt-bulk-bar .mt-chip-count {
      margin-left: 4px;
      background: rgba(255,255,255,0.25);
      padding: 0 4px; border-radius: 6px; font-size: 10px;
    }
    .mt-bulk-bar .mt-chip:not(.mt-chip-active) .mt-chip-count {
      background: #e7f0f8; color: #24476b;
    }
    /* CSV export mini-button */
    .mt-bulk-bar .mt-csv-btn {
      padding: 3px 10px; border-radius: 2px; font-size: 11px; font-weight: 600;
      border: 1px solid #c5ced8; background: #fff; color: #24476b; cursor: pointer;
      font-family: Roboto, sans-serif; white-space: nowrap; flex: 0 0 auto;
    }
    .mt-bulk-bar .mt-csv-btn:hover { background: #e7f0f8; border-color: #24476b; }
    .mt-bulk-bar select,
    .mt-bulk-bar input[type="text"] {
      padding: 3px 6px;
      border: 1px solid #c5ced8;
      border-radius: 2px;
      font-size: 12px;
      font-family: Roboto, sans-serif;
      background: #fff;
    }
    /* Fixed widths (not min-width) so the top-row layout is stable regardless
       of which option is selected — otherwise "Collected by customer" widens
       the select, pushing Apply to Selected onto a new line. */
    .mt-bulk-bar select.mt-bulk-route { width: 180px; flex: 0 0 180px; }
    .mt-bulk-bar select.mt-bulk-status { width: 200px; flex: 0 0 200px; }
    .mt-bulk-bar input.mt-bulk-track { width: 130px; flex: 0 0 130px; }
    .mt-bulk-bar input.mt-bulk-eta { width: 140px; flex: 0 0 140px; }
    /* When "Clear ETA" is ticked, dim the date input to make the precedence
       obvious — the checkbox wins and the date is ignored. */
    .mt-bulk-bar.mt-bulk-eta-clearing input.mt-bulk-eta { opacity: 0.4; pointer-events: none; }
    .mt-bulk-bar .mt-bulk-btn {
      padding: 4px 12px;
      background: #3071a9;
      color: #fff;
      border: 1px solid #285e8e;
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .mt-bulk-bar .mt-bulk-btn:hover:not(:disabled) { background: #285e8e; }
    .mt-bulk-bar .mt-bulk-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .mt-bulk-bar .mt-sep { color: #a8b2bd; padding: 0 2px; }
    .mt-bulk-bar .mt-selected-count { font-weight: 600; color: #24476b; }
    .mt-bulk-bar .mt-auto-hint {
      font-style: italic; color: #697783;
      font-size: 11px;
    }
    /* Progress track (uses SimPro's native progress if available) */
    .mt-bulk-bar progress.mt-progress-native {
      width: 160px; height: 14px;
      vertical-align: middle;
    }
    .mt-bulk-bar .mt-progress-text {
      font-size: 11px; color: #24476b; font-weight: 600; min-width: 34px;
    }
    .mt-spacer { flex: 1; }
    .mt-user-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 8px;
      background: #e7f0f8; border: 1px solid #c5d5e6;
      border-radius: 10px; font-size: 11px; color: #24476b;
    }
    .mt-user-chip a { color: #c9302c; cursor: pointer; text-decoration: underline; font-size: 11px; }

    /* ── Info icon (audit popup trigger) ─────────────────────────────────── */
    button.mt-info-btn {
      background: transparent; border: 1px solid #c5ced8; border-radius: 50%;
      width: 20px; height: 20px; cursor: pointer; color: #3071a9;
      font-weight: 700; font-size: 11px; line-height: 1; padding: 0;
      font-family: Roboto, sans-serif;
    }
    button.mt-info-btn:hover { background: #e7f0f8; border-color: #3071a9; }

    /* ── Toast ───────────────────────────────────────────────────────────── */
    .mt-toast {
      position: fixed; right: 16px; bottom: 16px;
      background: #2d3a4a; color: #fff; padding: 10px 14px;
      border-radius: 4px; font-size: 13px; z-index: 99999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      opacity: 0; transition: opacity 0.3s;
      max-width: 360px;
    }
    .mt-toast.show { opacity: 1; }
    .mt-toast.error { background: #c9302c; }

    /* ── Modal ───────────────────────────────────────────────────────────── */
    .mt-modal-backdrop {
      position: fixed; inset: 0; background: rgba(30,40,55,0.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 99998;
    }
    .mt-modal {
      background: #fff; border-radius: 4px; padding: 20px 24px;
      max-width: 560px; max-height: 80vh; overflow: auto;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      font: 13px/1.45 Roboto, sans-serif; color: rgb(35, 42, 47);
    }
    .mt-modal.small { width: 360px; }
    .mt-modal h3 { margin: 0 0 12px; font-size: 16px; color: #24476b; }
    .mt-modal label { display: block; margin: 8px 0 3px; font-weight: 600; font-size: 12px; color: #333; }
    .mt-modal input { width: 100%; padding: 6px 8px; border: 1px solid #c5ced8; border-radius: 2px; box-sizing: border-box; }
    .mt-modal .mt-modal-actions { display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end; }
    .mt-modal .mt-modal-actions button {
      padding: 6px 12px; border-radius: 2px; font-size: 13px; cursor: pointer;
    }
    .mt-modal .mt-modal-actions .primary { background: #3071a9; color: #fff; border: 1px solid #285e8e; }
    .mt-modal .mt-modal-actions .secondary { background: #fff; color: #333; border: 1px solid #c5ced8; }
    .mt-modal .mt-modal-error { color: #c9302c; font-size: 12px; margin-top: 6px; min-height: 16px; }
    .mt-audit-row {
      display: grid; grid-template-columns: 220px 1fr; gap: 4px 12px;
      padding: 8px 0; border-bottom: 1px solid #e8ecef; font-size: 12px;
      align-items: baseline;
    }
    /* Scrollable audit list — prevents the modal from overflowing the screen
       when a record has many changes. */
    .mt-audit-list { max-height: 55vh; overflow-y: auto; }
    .mt-audit-row:last-child { border-bottom: none; }
    .mt-audit-row .mt-audit-meta { display: flex; flex-direction: column; }
    .mt-audit-row .mt-audit-when { color: #697783; font-size: 11px; }
    .mt-audit-row .mt-audit-who { color: #24476b; font-weight: 600; word-break: break-all; }
    .mt-audit-row .mt-audit-field { overflow-wrap: anywhere; }
    .mt-audit-row .mt-audit-field b { color: #333; }
    .mt-audit-row .mt-audit-arrow { color: #9aa5b1; padding: 0 4px; }
    .mt-audit-empty { color: #697783; font-style: italic; padding: 8px 0; }

    /* ── Admin: users & roles modal ──────────────────────────────────────── */
    .mt-modal.mt-users-modal { width: 520px; max-width: 90vw; }
    .mt-users-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
    .mt-users-table th, .mt-users-table td {
      padding: 5px 6px; border-bottom: 1px solid #e8ecef; text-align: left;
      vertical-align: middle;
    }
    .mt-users-table th { color: #697783; font-weight: 600; }
    .mt-users-table select {
      padding: 2px 4px; border: 1px solid #c5ced8; border-radius: 2px; font-size: 12px;
    }
    .mt-users-hint { font-size: 11px; color: #697783; margin-top: 8px; }

    /* ── Job-list page: materials progress row blended into cost-centre header ── */
    .mt-jl-row {
      display: flex; align-items: center; gap: 6px;
      margin-top: 2px;
      font: 12px/1.4 Roboto, sans-serif;
    }
    .mt-jl-label { text-align: right; font-weight: 600; }
    .mt-jl-progress-wrap { display: inline-flex; align-items: center; gap: 6px; }
    .mt-jl-progress { width: 120px; height: 12px; }
    .mt-jl-progress-text { font-size: 11px; color: #24476b; }
    .mt-jl-progress-text.warn { color: #c9302c; font-weight: 600; }
  `);

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function waitFor(predicate, { timeout = 15000, interval = 150 } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        try {
          const v = predicate();
          if (v) return resolve(v);
        } catch (e) { /* keep polling */ }
        if (Date.now() - start > timeout) return reject(new Error('timeout'));
        setTimeout(poll, interval);
      })();
    });
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function toast(msg, { error: isErr = false, ms = 3200 } = {}) {
    const el = document.createElement('div');
    el.className = 'mt-toast' + (isErr ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 400);
    }, ms);
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-GB', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function modalPrompt({ title, fields, submitLabel = 'Submit', cancelLabel = 'Cancel' }) {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'mt-modal-backdrop';
      const form = document.createElement('form');
      form.className = 'mt-modal small';
      form.innerHTML = `<h3>${escapeHtml(title)}</h3>` +
        fields.map(f => `<label>${escapeHtml(f.label)}</label><input type="${escapeHtml(f.type||'text')}" name="${escapeHtml(f.name)}" ${f.required?'required':''} value="${escapeHtml(f.value||'')}">`).join('') +
        `<div class="mt-modal-error"></div>
         <div class="mt-modal-actions">
           <button type="button" class="secondary" data-act="cancel">${escapeHtml(cancelLabel)}</button>
           <button type="submit" class="primary">${escapeHtml(submitLabel)}</button>
         </div>`;
      backdrop.appendChild(form);
      document.body.appendChild(backdrop);
      form.querySelector('input')?.focus();
      const close = (result) => { backdrop.remove(); resolve(result); };
      form.querySelector('[data-act="cancel"]').onclick = () => close(null);
      form.onsubmit = (e) => {
        e.preventDefault();
        const data = {};
        for (const f of fields) data[f.name] = form.elements[f.name].value;
        close({ data, setError: () => {} });
      };
    });
  }

  function modalHtml({ title, innerHtml, onClose }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'mt-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'mt-modal';
    modal.innerHTML = `<h3>${escapeHtml(title)}</h3>${innerHtml}
      <div class="mt-modal-actions">
        <button type="button" class="secondary" data-act="close">Close</button>
      </div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const close = () => { backdrop.remove(); onClose?.(); };
    modal.querySelector('[data-act="close"]').onclick = close;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    return { backdrop, modal, close };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. CONTEXT EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════════
  function extractCostCentreContext() {
    // Cost-centre edit page context
    const url = new URL(location.href);
    const sectionID = parseInt(url.searchParams.get('sectionID'), 10);

    const jobMatch = document.body.innerText.match(/Project Job\s*#(\d+)/i);
    const jobID = jobMatch ? parseInt(jobMatch[1], 10) : NaN;

    let costCentreID = NaN, costCentreName = null;
    const textLines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of textLines) {
      const m = line.match(/Cost Centres\s*\/\s*(.+?)\s*#(\d+)\s*$/);
      if (m) { costCentreName = m[1].trim(); costCentreID = parseInt(m[2], 10); break; }
    }
    return { jobID, sectionID, costCentreID, costCentreName };
  }

  function extractJobListContext() {
    // Job list page context — just the jobID; cost-centre mapping is by name.
    const jobMatch = document.body.innerText.match(/Project Job\s*#(\d+)/i);
    const jobID = jobMatch ? parseInt(jobMatch[1], 10) : NaN;
    return { jobID };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. ROW PARSING (cost-centre edit page)
  // ═══════════════════════════════════════════════════════════════════════════
  function parseAllocationRows(table) {
    const rows = [...table.querySelectorAll('tbody tr.assignFromStock')];
    const out = [];
    const pairSeen = new Map();
    // Carry-forward state for sub-rows (stock-location expansions).
    // Sub-rows have only ~7 native TDs (cells[0] is an empty colspan=8 cell)
    // vs ~15 for main material rows, so we detect them by cell count < 10.
    let lastMaterialName = null;
    let lastRequiredQty = null;
    for (const row of rows) {
      const stockInput = row.querySelector('input[name^="stock["]');
      if (!stockInput) continue;
      const m = stockInput.name.match(/^stock\[(\d+)\]\[(\d+)\]$/);
      if (!m) continue;
      const material_id = parseInt(m[1], 10);
      const location_id = parseInt(m[2], 10);
      const key = material_id + '|' + location_id;
      const occurrence_index = pairSeen.get(key) ?? 0;
      pairSeen.set(key, occurrence_index + 1);

      const cells = [...row.querySelectorAll('td')];
      // Sub-rows (personal/secondary stock locations like "PN_Darren H. Stock")
      // have cells[0] as an empty colspan=8 placeholder. Main rows have the
      // material name in cells[0] and the warehouse location in cells[8].
      const isSubRow = cells.length < 10;
      if (!isSubRow) {
        // Main row — update carry-forward state.
        lastMaterialName = (cells[0]?.innerText || '').trim().slice(0, 300) || null;
        lastRequiredQty = parseFloat(cells[1]?.innerText || '') || null;
      }
      const material_name = isSubRow ? lastMaterialName
        : (cells[0]?.innerText || '').trim().slice(0, 300) || null;
      const required_qty = isSubRow ? lastRequiredQty
        : parseFloat(cells[1]?.innerText || '') || null;
      // stockInput.value is the qty being assigned from this specific location —
      // the same input that SimPro uses for the allocation spinner. Using
      // innerText would always give '' for <input> elements (fixed in v1.6.6).
      const assigned_qty = parseFloat(stockInput.value || '') || null;
      // Sub-row: location label is in cells[1] ("Stored at PN_Darren H. Stock").
      // Main row: location label is in cells[8] (the warehouse name cell).
      const location_name = isSubRow
        ? (cells[1]?.innerText || '').trim() || null
        : (cells[8]?.innerText || '').trim() || null;
      // in_stock_qty: how many units are physically available at this location.
      // Main rows only — cells[9] is the "In Stock" column (e.g. "2 [0]" where 2
      // is the physical count and [0] is the already-reserved amount).
      // parseFloat stops at the first non-numeric character, so "2 [0]" → 2.
      // Sub-rows do not have a dedicated In Stock cell (they inherit from the
      // parent location), so we leave it null and rely on assigned_qty there.
      const in_stock_qty = isSubRow
        ? null
        : (parseFloat(cells[9]?.innerText || '') || null);

      out.push({
        row, material_id, location_id, occurrence_index,
        material_name, required_qty, assigned_qty, in_stock_qty, location_name,
      });
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. SUPABASE CLIENT + AUTH
  // ═══════════════════════════════════════════════════════════════════════════
  let sb = null;
  let currentUser = null;
  let currentUserRole = null; // 'admin' | 'editor' | 'readonly' — populated after sign-in
  let currentStockTab = 'All'; // active stock sub-tab; written by syncAllocatedView, read by applyFilter

  function initClient() {
    if (sb) return sb;
    const { createClient } = supabase;
    // Use Tampermonkey's GM_getValue/setValue as the auth storage instead of
    // window.localStorage. localStorage is per-origin: a session created on
    // powernaturally.simprosuite.com is invisible to reportbuilder.simprosuite.com.
    // GM storage is shared across all domains that run this userscript, so signing
    // in once on a SimPro cost-centre page automatically covers the BI page too.
    const gmStorage = {
      getItem: k => GM_getValue(k, null),
      setItem: (k, v) => GM_setValue(k, v),
      removeItem: k => GM_deleteValue(k),
    };
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: 'mt-auth',
        storage: gmStorage,
      },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    return sb;
  }

  async function ensureAuth({ requireInteractive = true } = {}) {
    initClient();
    const { data: { session } } = await sb.auth.getSession();
    if (session?.user) {
      currentUser = session.user;
      await loadCurrentUserRole();
      return session.user;
    }
    if (!requireInteractive) return null;
    while (true) {
      const r = await modalPrompt({
        title: 'Sign in to Materials Tracker',
        fields: [
          { name: 'email', label: 'Email', type: 'email', required: true, value: GM_getValue('lastEmail', '') },
          { name: 'password', label: 'Password', type: 'password', required: true },
        ],
        submitLabel: 'Sign in',
      });
      if (!r) return null;
      const { email, password } = r.data;
      const { data, error: e } = await sb.auth.signInWithPassword({ email, password });
      if (e) { toast('Sign-in failed: ' + e.message, { error: true }); continue; }
      GM_setValue('lastEmail', email);
      currentUser = data.user;
      await loadCurrentUserRole();
      return data.user;
    }
  }

  async function loadCurrentUserRole() {
    // Two-step lookup: RPC first (exists post-0004_user_roles migration), then
    // a direct profile select as a fallback. If both fail we assume 'readonly'
    // so the UI degrades safely.
    try {
      const { data, error } = await sb.rpc('current_user_role');
      if (!error && data) { currentUserRole = data; log('role', currentUserRole); return; }
      if (error) warn('rpc current_user_role failed — falling back to profile select', error.message || error);
    } catch (e) { warn('rpc threw', e); }
    try {
      const { data, error } = await sb
        .from('user_profiles')
        .select('role')
        .eq('user_id', currentUser.id)
        .maybeSingle();
      if (error) { warn('profile select failed', error.message || error); }
      currentUserRole = data?.role || 'readonly';
      log('role (fallback)', currentUserRole);
    } catch (e) {
      warn('profile select threw — defaulting to readonly', e);
      currentUserRole = 'readonly';
    }
  }

  async function signOut() {
    await sb.auth.signOut();
    currentUser = null;
    location.reload();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. DATA SYNC
  // ═══════════════════════════════════════════════════════════════════════════
  async function ensureRecords(ctx, rows) {
    const { data: existing, error: fetchErr } = await sb
      .from('tracking_records')
      .select('*')
      .eq('job_id', ctx.jobID)
      .eq('cost_centre_id', ctx.costCentreID)
      .eq('section_id', ctx.sectionID);
    if (fetchErr) throw new Error('Fetch failed: ' + fetchErr.message);

    const mapKey = r => `${r.material_id}|${r.location_id}|${r.occurrence_index}`;
    const existingMap = new Map(existing.map(r => [mapKey(r), r]));

    // Readonly users can browse what's already in the DB but must never trigger
    // the seeding insert (RLS would reject it anyway — we just skip cleanly to
    // avoid a scary error toast on every page load).
    if (currentUserRole === 'readonly') {
      const missing = rows.filter(r => !existingMap.has(mapKey(r))).length;
      if (missing) log('read-only user — skipping initial insert of', missing, 'rows');
      return existingMap;
    }

    const toInsert = [];
    const toUpdate = []; // rows where SimPro's qty differs from our stored value
    for (const r of rows) {
      const key = mapKey(r);
      if (!existingMap.has(key)) {
        toInsert.push({
          job_id: ctx.jobID,
          cost_centre_id: ctx.costCentreID,
          section_id: ctx.sectionID,
          material_id: r.material_id,
          location_id: r.location_id,
          occurrence_index: r.occurrence_index,
          material_name: r.material_name,
          location_name: r.location_name,
          required_qty: r.required_qty,
          assigned_qty: r.assigned_qty,
          status: 'not_actioned',
          created_by: currentUser.id,
          updated_by: currentUser.id,
        });
      } else {
        // Sync qty fields: SimPro is the source of truth for quantities.
        // assigned_qty and required_qty can change in SimPro without the user
        // touching the tracking record — if we leave them stale the BI progress
        // calculation uses the wrong denominator and diverges from the CC page.
        const stored = existingMap.get(key);
        // Guard: only propagate an assigned_qty decrease-to-null if the DOM
        // value is genuinely non-null. A null/zero value from parseAllocationRows
        // may be a timing artefact — SimPro sometimes initialises stock inputs
        // asynchronously AFTER document-idle fires, so we can briefly see 0 even
        // when stock IS assigned. Writing that 0 back to Supabase would corrupt
        // the BI progress denominator for every user. We still allow legitimate
        // updates (non-null → different non-null, or null → non-null).
        const aqChanged = stored.assigned_qty !== r.assigned_qty &&
                          (r.assigned_qty != null || stored.assigned_qty == null);
        const rqChanged = stored.required_qty !== r.required_qty;
        if (aqChanged || rqChanged) {
          toUpdate.push({ id: stored.id, assigned_qty: r.assigned_qty, required_qty: r.required_qty });
          // Patch local map immediately so callers see fresh values
          existingMap.set(key, { ...stored, assigned_qty: r.assigned_qty, required_qty: r.required_qty });
        }
      }
    }
    if (toInsert.length) {
      const { data: inserted, error: insErr } = await sb
        .from('tracking_records')
        .insert(toInsert)
        .select();
      if (insErr) throw new Error('Insert failed: ' + insErr.message);
      for (const rec of inserted) existingMap.set(mapKey(rec), rec);
      log('inserted', inserted.length, 'new tracking records');
    }
    if (toUpdate.length) {
      // Batch qty updates — one request per changed record (usually 0 or few).
      await Promise.all(toUpdate.map(({ id, assigned_qty, required_qty }) =>
        sb.from('tracking_records').update({ assigned_qty, required_qty }).eq('id', id)
      ));
      log('synced qty for', toUpdate.length, 'existing tracking record(s)');
    }
    return existingMap;
  }

  // Admin-only: list all users + roles, let admin change roles inline.
  async function openUsersAdminModal() {
    if (currentUserRole !== 'admin') { toast('Admins only', { error: true }); return; }
    const { modal } = modalHtml({
      title: 'Manage users & roles',
      innerHtml: `
        <p style="margin:0 0 6px;color:#697783;font-size:12px;">
          Roles: <b>admin</b> (full + user management), <b>editor</b> (read/write tracking),
          <b>readonly</b> (view only). New users default to <b>readonly</b>.
        </p>
        <div class="mt-users-wrap"><div class="mt-audit-empty">Loading…</div></div>
        <p class="mt-users-hint">
          To <b>add a user</b>: Supabase dashboard → Authentication → Users → Add user.
          They'll appear here on next page load.
        </p>
      `,
    });
    const wrap = modal.querySelector('.mt-users-wrap');
    try {
      const { data, error } = await sb
        .from('user_profiles')
        .select('user_id, email, role, created_at')
        .order('created_at', { ascending: true });
      if (error) throw error;
      // Warm the global email cache so audit modals show full emails without
      // needing a separate fetch.
      if (data) data.forEach(u => { if (u.email) userEmailCache.set(u.user_id, u.email); });
      if (!data?.length) { wrap.innerHTML = `<div class="mt-audit-empty">No users yet.</div>`; return; }
      wrap.innerHTML = `
        <table class="mt-users-table">
          <thead><tr><th>Email</th><th style="width:120px;">Role</th></tr></thead>
          <tbody>
            ${data.map(u => {
              const isSelf = u.user_id === currentUser.id;
              const selfAttr = isSelf ? 'disabled title="Cannot change your own role — ask another admin"' : '';
              return `
                <tr data-uid="${escapeHtml(u.user_id)}">
                  <td>${escapeHtml(u.email || u.user_id)}${isSelf ? ' <small style="color:#697783;">(you)</small>' : ''}</td>
                  <td>
                    <select class="mt-role-sel" data-prev="${escapeHtml(u.role)}" ${selfAttr}>
                      <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
                      <option value="editor" ${u.role==='editor'?'selected':''}>Editor</option>
                      <option value="readonly" ${u.role==='readonly'?'selected':''}>Readonly</option>
                    </select>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
      wrap.querySelectorAll('.mt-role-sel').forEach(sel => {
        sel.addEventListener('change', async () => {
          const uid = sel.closest('tr').dataset.uid;
          const newRole = sel.value;
          const prev = sel.dataset.prev;
          sel.disabled = true;
          const { error } = await sb.from('user_profiles').update({ role: newRole, updated_at: new Date().toISOString() }).eq('user_id', uid);
          sel.disabled = false;
          if (error) {
            err('role update failed', error);
            toast('Role update failed: ' + error.message, { error: true });
            sel.value = prev; // revert
          } else {
            sel.dataset.prev = newRole;
            toast('Role updated');
          }
        });
      });
    } catch (e) {
      err('users fetch failed', e);
      wrap.innerHTML = `<div class="mt-audit-empty">Failed to load users: ${escapeHtml(e.message || e)}</div>`;
    }
  }

  async function updateRecord(recordId, changes) {
    const payload = { ...changes, updated_by: currentUser.id };
    log('update', recordId, payload);
    const { data, error } = await sb
      .from('tracking_records')
      .update(payload)
      .eq('id', recordId)
      .select()
      .single();
    if (error) {
      err('update failed', error, 'payload:', payload);
      // Dress up the most common diagnosable errors so the toast is actionable.
      const msg = error.message || String(error);
      if (/invalid input value for enum/i.test(msg) || error.code === '22P02') {
        const which = /delivery_status/i.test(msg) ? 'status'
                    : /delivery_route/i.test(msg) ? 'route'
                    : 'enum';
        throw new Error(`${which} value not in database — run migration 0003_add_route_and_status_values.sql in Supabase SQL editor`);
      }
      if (error.code === '42501' || /row-level security/i.test(msg)) {
        throw new Error(`You don't have permission to edit (${currentUserRole || 'unknown'} role). Ask an admin to promote you to editor.`);
      }
      throw error;
    }
    return data;
  }

  async function fetchAudit(recordId) {
    const { data, error } = await sb
      .from('tracking_audit')
      .select('*')
      .eq('record_id', recordId)
      .order('changed_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return data;
  }

  // Bulk fetch user emails for audit display. Supabase exposes `auth.users` only
  // to service_role, so we keep a localStorage cache and fall back to "<uid short>"
  // if unknown. The user's own email is known via currentUser.email.
  const userEmailCache = new Map();
  function userEmailForAudit(uid) {
    if (!uid) return '—';
    if (uid === currentUser?.id) return currentUser.email;
    return userEmailCache.get(uid) || (uid.slice(0, 8) + '…');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. UI INJECTION — cost-centre edit page
  // ═══════════════════════════════════════════════════════════════════════════
  const MT_COLS = [
    { key: 'route', label: 'Route', cls: 'mt-col-route' },
    { key: 'tracking_no', label: 'Track. No.', cls: 'mt-col-track' },
    { key: 'eta', label: 'ETA', cls: 'mt-col-eta' },
    { key: 'status', label: 'Status', cls: 'mt-col-status' },
    { key: 'info', label: 'ⓘ', cls: 'mt-col-info' },
  ];

  // Headers: 0 Name, 1 Required, 2 _, 3 Assigned, 4 _, 5 Needed, 6 _, 7 Value,
  // 8 Stored at, 9 In Stock, 10 _, 11 Move Difference To, 12 Assigned, 13 _
  const INSERT_AFTER_IDX = 11;

  function injectHeaders(table) {
    const headerRows = [...table.querySelectorAll('thead tr'), ...table.querySelectorAll('tbody tr.tblHeader')];
    for (const hrow of headerRows) {
      if (hrow.dataset.mtHeaderInjected) continue;
      hrow.dataset.mtHeaderInjected = '1';
      // Leading checkbox column
      const chkTh = document.createElement('th');
      chkTh.className = 'mt-check';
      const readonly = currentUserRole === 'readonly';
      chkTh.innerHTML = `<input type="checkbox" class="mt-select-all" title="${readonly ? 'Read-only user' : 'Select all'}" ${readonly ? 'disabled' : ''}>`;
      hrow.insertBefore(chkTh, hrow.firstChild);
      const cells = [...hrow.querySelectorAll('th, td')];
      const target = cells[INSERT_AFTER_IDX + 1];
      for (const col of MT_COLS) {
        const th = document.createElement('th');
        th.className = 'mt-col-head ' + col.cls;
        th.textContent = col.label;
        if (target) hrow.insertBefore(th, target); else hrow.appendChild(th);
      }
    }
  }

  function buildRouteSelect(current) {
    const sel = document.createElement('select');
    sel.className = 'mt-select mt-route';
    sel.style.width = '100%';
    sel.innerHTML = `<option value="">—</option>` +
      ROUTES.map(r =>
        `<option value="${r.value}" title="${escapeHtml(r.title)}" ${r.value===current?'selected':''}>${escapeHtml(r.label)}</option>`
      ).join('');
    // Show the full route description as a native browser tooltip on hover
    const cur = ROUTES.find(r => r.value === current);
    sel.title = cur ? cur.title : '';
    return sel;
  }
  function buildStatusSelect(current) {
    const sel = document.createElement('select');
    sel.className = 'mt-select mt-status';
    sel.innerHTML = STATUSES.map(s => `<option value="${s.value}" ${s.value===current?'selected':''}>${escapeHtml(s.label)}</option>`).join('');
    applyStatusTier(sel, current || 'not_actioned');
    return sel;
  }
  function applyStatusTier(sel, value) {
    sel.classList.remove('mt-tier-0','mt-tier-1','mt-tier-2','mt-tier-3','mt-tier-4','mt-tier-9');
    const tier = STATUS_BY_VALUE[value]?.tier ?? 0;
    sel.classList.add('mt-tier-' + tier);
    // Also colour the enclosing td so the whole cell reflects the status.
    const td = sel.closest('td.mt-status-cell');
    if (td) {
      td.classList.remove('mt-cell-tier-0','mt-cell-tier-1','mt-cell-tier-2','mt-cell-tier-3','mt-cell-tier-4','mt-cell-tier-9');
      td.classList.add('mt-cell-tier-' + tier);
    }
  }

  function injectRowCells(parsedRow, record, onChange, ctx) {
    const { row } = parsedRow;
    if (row.dataset.mtInjected) return;
    row.dataset.mtInjected = '1';
    row.dataset.mtRecordId = record.id;
    const readonly = currentUserRole === 'readonly';
    // A row is "unassigned" (MT cells locked) only when BOTH the assignment
    // spinner AND the In Stock quantity are zero/null — i.e. there is genuinely
    // nothing physical to track yet. If stock is available at the location
    // (in_stock_qty > 0) the row is trackable even before SimPro's formal
    // assignment step, so warehouse staff can pre-fill route/tracking/ETA
    // before the job formally draws from stock.
    const unassigned = !parsedRow.assigned_qty && !parsedRow.in_stock_qty;
    if (unassigned) row.classList.add('mt-unassigned');

    // Leading checkbox cell — disabled for readonly users (no bulk apply available)
    // and for unassigned rows (nothing to bulk-apply to a zero-qty line).
    const chkTd = document.createElement('td');
    chkTd.className = 'mt-check';
    chkTd.innerHTML = `<input type="checkbox" class="mt-row-check" ${(readonly || unassigned) ? 'disabled' : ''}>`;
    row.insertBefore(chkTd, row.firstChild);

    const cells = [...row.querySelectorAll('td')];
    // Sub-rows span the Name→Value columns with colspan=8 on their second TD,
    // leaving only ~8 native cells (vs ~15 for main rows after our checkbox).
    // Insert our MT columns before the stock-location link (cells[5]) so they
    // land on the same visual columns as main rows (MT Route = effective col 12).
    // Main rows: insert before cells[12] (the Move-Difference-To link).
    const isSubRow = cells.length < 10;
    const target = cells[(isSubRow ? 4 : INSERT_AFTER_IDX) + 1];

    // Route cell
    const routeTd = document.createElement('td'); routeTd.className = 'mt-cell mt-route-cell';
    const routeSel = buildRouteSelect(record.route);
    if (readonly || unassigned) routeSel.disabled = true;
    routeTd.appendChild(routeSel);
    if (target) row.insertBefore(routeTd, target); else row.appendChild(routeTd);

    // Tracking cell — display only (edits go through the bulk bar), BUT we
    // give every row a Copy button so warehouse staff can copy a tracking
    // reference into a carrier's site without fiddly text selection.
    const trackTd = document.createElement('td'); trackTd.className = 'mt-cell mt-track-cell';
    const trackWrap = document.createElement('span'); trackWrap.className = 'mt-track-wrap';
    const trackInp = document.createElement('input');
    trackInp.type = 'text'; trackInp.className = 'mt-track';
    trackInp.value = record.tracking_no || '';
    trackInp.placeholder = '—';
    trackInp.readOnly = true;
    trackInp.title = 'Tracking number is applied via the "Apply to Selected" bar — tick the row, enter a number, click Apply.';
    const trackCopy = document.createElement('button');
    trackCopy.type = 'button'; trackCopy.className = 'mt-track-copy';
    trackCopy.textContent = '⎘';
    trackCopy.title = 'Copy tracking number';
    trackCopy.disabled = !record.tracking_no;
    trackCopy.addEventListener('click', async () => {
      const v = trackInp.value;
      if (!v) return;
      try { await navigator.clipboard.writeText(v); toast('Copied: ' + v); }
      catch (e) { toast('Copy failed: ' + (e.message || e), { error: true }); }
    });
    trackWrap.appendChild(trackInp);
    trackWrap.appendChild(trackCopy);
    trackTd.appendChild(trackWrap);
    if (target) row.insertBefore(trackTd, target); else row.appendChild(trackTd);

    // ETA cell — optional date. Lights up amber ≤3 days out, red when past-due.
    const etaTd = document.createElement('td'); etaTd.className = 'mt-cell mt-eta-cell';
    const etaInp = document.createElement('input');
    etaInp.type = 'date'; etaInp.className = 'mt-eta';
    etaInp.value = record.eta || '';
    if (readonly || unassigned) etaInp.disabled = true;
    applyEtaClass(etaInp, record.eta, record.status);
    etaTd.appendChild(etaInp);
    if (target) row.insertBefore(etaTd, target); else row.appendChild(etaTd);

    // Status cell
    const statusTd = document.createElement('td'); statusTd.className = 'mt-cell mt-status-cell';
    const statusSel = buildStatusSelect(record.status);
    if (readonly || unassigned) statusSel.disabled = true;
    statusTd.appendChild(statusSel);
    if (target) row.insertBefore(statusTd, target); else row.appendChild(statusTd);

    // Info cell
    const infoTd = document.createElement('td'); infoTd.className = 'mt-cell mt-info-cell';
    const infoBtn = document.createElement('button');
    infoBtn.type = 'button'; infoBtn.className = 'mt-info-btn';
    infoBtn.textContent = 'i';
    infoBtn.title = unassigned ? 'No quantity assigned — assign stock in SimPro to enable tracking' : 'Change history';
    if (unassigned) infoBtn.disabled = true;
    infoBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't let SimPro intercept clicks inside its table.
      e.preventDefault(); // Prevent any form-submit / default action SimPro may bind.
      openAuditModal(record.id, parsedRow, record, ctx); // ctx === recordsRef here
    });
    infoTd.appendChild(infoBtn);
    if (target) row.insertBefore(infoTd, target); else row.appendChild(infoTd);

    // ─────────────────────────────────────────────────────────────────────
    // Per-row save.
    //
    // v1.4 used debounce(400). That masked a subtle bug: if the user picked
    // a value and navigated (or the scheduler deferred the callback beyond
    // a tab repaint), the save appeared to "disappear". v1.5 saves IMMEDIATELY
    // on every change, with only the single field that changed in the patch
    // so the audit log records the intent precisely.
    //
    // Tracking_no is still bar-only (read-only here). ETA + Route + Status
    // all flow through saveField.
    // ─────────────────────────────────────────────────────────────────────
    async function saveField(field, value) {
      const changes = { [field]: value };
      log('per-row save start', { recordId: record.id, field, value });
      row.classList.remove('mt-error', 'mt-saved');
      row.classList.add('mt-dirty');
      const safety = setTimeout(() => {
        row.classList.remove('mt-dirty');
        warn('per-row save safety-timeout fired', { recordId: record.id, field });
      }, 10000);
      try {
        const saved = await onChange(record.id, changes);
        log('per-row save ok', { recordId: record.id, field, saved });
        Object.assign(record, saved);
        applyStatusTier(statusSel, saved.status);
        applyEtaClass(etaInp, saved.eta, saved.status);
        trackCopy.disabled = !saved.tracking_no;
        ctx.onRecordSaved?.(saved);
        row.classList.remove('mt-dirty');
        row.classList.add('mt-saved');
        setTimeout(() => row.classList.remove('mt-saved'), 900);
      } catch (e) {
        row.classList.remove('mt-dirty');
        row.classList.add('mt-error');
        err('per-row save failed', { recordId: record.id, field, value, error: e });
        toast('Save failed: ' + (e.message || e), { error: true });
      } finally {
        clearTimeout(safety);
      }
    }

    if (!readonly && !unassigned) {
      // IMPORTANT: stopPropagation on every per-row input change. SimPro's own
      // page JS attaches DELEGATED handlers on the materials form (e.g. for
      // their native Required-Date inputs, qty inputs, etc.). When our
      // <input type="date">.mt-eta change event bubbled up, SimPro's handler
      // treated it as one of its own date fields and triggered a partial
      // re-render of the table — which wiped every injected cell and made
      // it look like all materials disappeared. v1.6 bugfix.
      routeSel.addEventListener('change', (e) => {
        e.stopPropagation();
        log('change: route', { recordId: record.id, value: routeSel.value });
        const rt = ROUTES.find(r => r.value === routeSel.value);
        routeSel.title = rt ? rt.title : '';
        saveField('route', routeSel.value || null);
      });
      statusSel.addEventListener('change', (e) => {
        e.stopPropagation();
        log('change: status', { recordId: record.id, value: statusSel.value });
        applyStatusTier(statusSel, statusSel.value);
        saveField('status', statusSel.value);
      });
      etaInp.addEventListener('change', (e) => {
        e.stopPropagation();
        log('change: eta', { recordId: record.id, value: etaInp.value });
        saveField('eta', etaInp.value || null);
      });
      // Date pickers also fire `input` while the user types in the segments —
      // some Tampermonkey hosts surface that to SimPro before `change`. Block
      // it too, but DON'T save (we save on commit/change only).
      etaInp.addEventListener('input', (e) => { e.stopPropagation(); });
    }
  }

  // ETA visual cue: red if past-due (and not yet delivered/receipt-confirmed),
  // amber if within 3 days, default otherwise. We peek at status so a
  // successfully-delivered row doesn't keep flashing red in perpetuity.
  function applyEtaClass(inp, eta, status) {
    inp.classList.remove('mt-eta-overdue', 'mt-eta-soon');
    if (!eta) return;
    const done = status === 'receipt_confirmed' || status === 'delivered';
    if (done) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const d = new Date(eta + 'T00:00:00');
    const diffDays = Math.round((d - today) / 86400000);
    if (diffDays < 0) inp.classList.add('mt-eta-overdue');
    else if (diffDays <= 3) inp.classList.add('mt-eta-soon');
  }

  async function openAuditModal(recordId, parsedRow, record, recordsRef) {
    const { modal } = modalHtml({
      title: `Change history`,
      innerHtml: `
        <div style="margin-bottom:10px; color:#697783; font-size:12px;">
          <b>${escapeHtml(record.material_name || '—')}</b> · ${escapeHtml(record.location_name || '—')}
        </div>
        <div class="mt-audit-list"><div class="mt-audit-empty">Loading…</div></div>
      `,
    });

    // Admin-only: delete the entire tracking record (and its audit trail).
    // The realtime subscription handles in-memory cleanup; we only need to
    // strip the MT cells from the DOM row ourselves.
    if (currentUserRole === 'admin') {
      const actions = modal.querySelector('.mt-modal-actions');
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '🗑 Delete record';
      delBtn.style.cssText = 'background:#c9302c;color:#fff;border:1px solid #8b1f1f;' +
        'border-radius:2px;padding:6px 12px;font-size:13px;cursor:pointer;margin-right:auto;';
      actions.insertBefore(delBtn, actions.firstChild);
      delBtn.addEventListener('click', async () => {
        const name = record.material_name || `record ${recordId}`;
        if (!confirm(`Reset tracking data for:\n"${name}"?\n\nAll history and field values will be erased and the row will revert to "Not actioned".`)) return;
        delBtn.disabled = true; delBtn.textContent = 'Resetting…';
        try {
          const { error } = await sb.from('tracking_records').delete().eq('id', recordId);
          if (error) throw error;

          // Remove the old record from the in-memory caches so the realtime
          // echo (DELETE event) doesn't double-process it.
          const oldKey = `${parsedRow.material_id}|${parsedRow.location_id}|${parsedRow.occurrence_index}`;
          recordsRef.recordMap.delete(oldKey);
          recordsRef.byId.delete(recordId);

          // Re-seed a fresh "not_actioned" record so the row stays fully
          // interactive — no broken / missing MT columns.
          let newRec = null;
          const pageCtx = recordsRef.pageCtx;
          if (pageCtx && currentUserRole !== 'readonly') {
            const { data: inserted, error: insErr } = await sb
              .from('tracking_records')
              .insert({
                job_id: pageCtx.jobID,
                cost_centre_id: pageCtx.costCentreID,
                section_id: pageCtx.sectionID,
                material_id: parsedRow.material_id,
                location_id: parsedRow.location_id,
                occurrence_index: parsedRow.occurrence_index,
                material_name: parsedRow.material_name,
                location_name: parsedRow.location_name,
                required_qty: parsedRow.required_qty,
                assigned_qty: parsedRow.assigned_qty,
                status: 'not_actioned',
                created_by: currentUser.id,
                updated_by: currentUser.id,
              })
              .select()
              .single();
            if (insErr) { warn('re-seed failed after delete', insErr); }
            else {
              newRec = inserted;
              recordsRef.recordMap.set(oldKey, newRec);
              recordsRef.byId.set(newRec.id, newRec);
            }
          }

          // Strip old MT cells, then re-inject with the fresh record.
          const domRow = document.querySelector(
            `#materialsTable tbody tr[data-mt-record-id="${recordId}"]`
          );
          if (domRow) {
            domRow.querySelectorAll('.mt-cell, .mt-check').forEach(td => td.remove());
            domRow.removeAttribute('data-mt-injected');
            domRow.removeAttribute('data-mt-record-id');
            domRow.classList.remove('mt-unassigned', 'mt-dirty', 'mt-saved', 'mt-error');
            if (newRec) injectRowCells(parsedRow, newRec, updateRecord, recordsRef);
          }

          modal.closest('.mt-modal-backdrop')?.remove();
          toast(newRec ? 'Row reset to "Not actioned"' : 'Tracking record deleted');
        } catch (e) {
          delBtn.disabled = false; delBtn.textContent = '🗑 Delete record';
          toast('Delete failed: ' + (e.message || e), { error: true });
        }
      });
    }

    const list = modal.querySelector('.mt-audit-list');
    try {
      const entries = await fetchAudit(recordId);
      if (!entries.length) {
        list.innerHTML = `<div class="mt-audit-empty">No history yet.</div>`;
        return;
      }
      // Warm email cache for any UIDs not yet known.
      const unknownUids = [...new Set(
        entries.map(e => e.changed_by)
          .filter(u => u && u !== currentUser?.id && !userEmailCache.has(u))
      )];
      if (unknownUids.length) {
        try {
          const { data: ps } = await sb
            .from('user_profiles').select('user_id, email').in('user_id', unknownUids);
          if (ps) ps.forEach(p => { if (p.email) userEmailCache.set(p.user_id, p.email); });
        } catch {}
      }
      list.innerHTML = entries.map(e => {
        const when = fmtDateTime(e.changed_at);
        const who = userEmailForAudit(e.changed_by);
        const meta = `<span class="mt-audit-meta">
            <span class="mt-audit-when">${escapeHtml(when)}</span>
            <span class="mt-audit-who">${escapeHtml(who)}</span>
          </span>`;
        if (e.op === 'INSERT') {
          return `<div class="mt-audit-row">${meta}<span class="mt-audit-field">created record</span></div>`;
        }
        const oldVal = e.old_value ? labelFor(e.field, e.old_value) : '∅';
        const newVal = e.new_value ? labelFor(e.field, e.new_value) : '∅';
        return `<div class="mt-audit-row">${meta}
          <span class="mt-audit-field">
            <b>${escapeHtml(e.field)}</b>:
            ${escapeHtml(oldVal)}<span class="mt-audit-arrow">→</span>${escapeHtml(newVal)}
          </span>
        </div>`;
      }).join('');
    } catch (e) {
      list.innerHTML = `<div class="mt-audit-empty">Failed to load history: ${escapeHtml(e.message || e)}</div>`;
    }
  }
  function labelFor(field, value) {
    if (field === 'status') return STATUS_BY_VALUE[value]?.label || value;
    if (field === 'route') return ROUTES.find(r => r.value === value)?.label || value;
    if (field === 'eta') return value || '—';
    return value;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cost-centre-wide audit log modal.
  // Shows every change across all tracking records for the current CC,
  // sorted newest-first. Note: entries for records that were fully deleted
  // from tracking_records (ON DELETE CASCADE) won't appear — that's a
  // known limitation addressed if we later add cost_centre_id to the audit
  // table directly.
  // ─────────────────────────────────────────────────────────────────────────
  async function openCCLogModal(ctx) {
    const { modal } = modalHtml({
      title: `CC Log — Cost Centre ${ctx.costCentreID}`,
      innerHtml: `<div class="mt-audit-list"><div class="mt-audit-empty">Loading…</div></div>`,
    });
    modal.style.maxWidth = '700px';
    const list = modal.querySelector('.mt-audit-list');
    try {
      // Step 1: fetch all tracking records for this CC to get their IDs + names.
      const { data: trs, error: trErr } = await sb
        .from('tracking_records')
        .select('id, material_name, location_name')
        .eq('cost_centre_id', ctx.costCentreID)
        .eq('job_id', ctx.jobID);
      if (trErr) throw trErr;
      if (!trs?.length) {
        list.innerHTML = `<div class="mt-audit-empty">No tracking records for this cost centre.</div>`;
        return;
      }
      const nameMap = new Map(trs.map(r => [
        r.id,
        { mat: r.material_name || '—', loc: r.location_name || '—' },
      ]));

      // Step 2: fetch all audit entries for those records.
      const { data: entries, error: auditErr } = await sb
        .from('tracking_audit')
        .select('*')
        .in('record_id', trs.map(r => r.id))
        .order('changed_at', { ascending: false })
        .limit(500);
      if (auditErr) throw auditErr;
      if (!entries?.length) {
        list.innerHTML = `<div class="mt-audit-empty">No changes recorded yet.</div>`;
        return;
      }

      // Warm email cache for any UIDs we haven't seen before.
      const unknownUids = [...new Set(
        entries.map(e => e.changed_by)
          .filter(u => u && u !== currentUser?.id && !userEmailCache.has(u))
      )];
      if (unknownUids.length) {
        try {
          const { data: ps } = await sb
            .from('user_profiles').select('user_id, email').in('user_id', unknownUids);
          if (ps) ps.forEach(p => { if (p.email) userEmailCache.set(p.user_id, p.email); });
        } catch {}
      }

      list.innerHTML = entries.map(e => {
        const info = nameMap.get(e.record_id) || { mat: '(deleted)', loc: '—' };
        const when = fmtDateTime(e.changed_at);
        const who = userEmailForAudit(e.changed_by);
        const meta = `<span class="mt-audit-meta">
          <span class="mt-audit-when">${escapeHtml(when)}</span>
          <span class="mt-audit-who">${escapeHtml(who)}</span>
        </span>`;
        const matLoc = `<span style="font-size:10px;color:#9aa5b1;display:block;margin-bottom:2px;">
          ${escapeHtml(info.mat)} · ${escapeHtml(info.loc)}
        </span>`;
        if (e.op === 'INSERT') {
          return `<div class="mt-audit-row">${meta}<span class="mt-audit-field">${matLoc}created record</span></div>`;
        }
        const oldVal = e.old_value ? labelFor(e.field, e.old_value) : '∅';
        const newVal = e.new_value ? labelFor(e.field, e.new_value) : '∅';
        return `<div class="mt-audit-row">${meta}
          <span class="mt-audit-field">${matLoc}
            <b>${escapeHtml(e.field)}</b>:
            ${escapeHtml(oldVal)}<span class="mt-audit-arrow">→</span>${escapeHtml(newVal)}
          </span>
        </div>`;
      }).join('');

      // CSV download button — flat columns: DateTime | User | Material |
      // Location | Field | Old Value | New Value.
      const actions = modal.querySelector('.mt-modal-actions');
      if (actions) {
        const csvBtn = document.createElement('button');
        csvBtn.type = 'button';
        csvBtn.className = 'secondary';
        csvBtn.textContent = '⬇ Download CSV';
        csvBtn.style.marginRight = 'auto';
        csvBtn.title = 'Download the full CC log as a CSV file';
        csvBtn.addEventListener('click', () => {
          const csvRows = [
            ['DateTime', 'User', 'Material', 'Location', 'Field', 'Old Value', 'New Value'],
          ];
          for (const ev of entries) {
            const info = nameMap.get(ev.record_id) || { mat: '(deleted)', loc: '—' };
            const when = fmtDateTime(ev.changed_at);
            const who = userEmailForAudit(ev.changed_by);
            if (ev.op === 'INSERT') {
              csvRows.push([when, who, info.mat, info.loc, 'created', '', '']);
            } else {
              const oldV = ev.old_value ? labelFor(ev.field, ev.old_value) : '';
              const newV = ev.new_value ? labelFor(ev.field, ev.new_value) : '';
              csvRows.push([when, who, info.mat, info.loc, ev.field, oldV, newV]);
            }
          }
          const csvText = csvRows
            .map(row => row.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(','))
            .join('\r\n');
          // UTF-8 BOM (﻿) tells Excel the file is UTF-8 so em dashes,
          // arrows and other non-ASCII chars render correctly instead of â€" etc.
          const blob = new Blob(['﻿' + csvText], { type: 'text/csv;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `CC-Log-${ctx.costCentreID}-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(url);
        });
        actions.insertBefore(csvBtn, actions.firstChild);
      }
    } catch (e) {
      list.innerHTML = `<div class="mt-audit-empty">Failed to load log: ${escapeHtml(e.message || e)}</div>`;
    }
  }

  function injectBulkBar({ records, recordsRef, onRefresh, filterApi, ctx }) {
    // Place the bar DIRECTLY ABOVE #materialsTable so it sits below the
    // "Assign from Stock / Assign from Stock Take" tabs and spans the
    // full width of the table container. Previous versions placed it
    // next to the "Update Materials" button which made the bar compete
    // for width with unrelated SimPro UI.
    const table = document.getElementById('materialsTable');
    if (!table || !table.parentElement) {
      warn('#materialsTable not found — bulk bar not placed');
      return null;
    }
    const host = table.parentElement;
    if (host.dataset.mtBulkInjected) return host.querySelector('.mt-bulk-bar');
    host.dataset.mtBulkInjected = '1';

    const bar = document.createElement('div');
    bar.className = 'mt-bulk-bar';
    if (currentUserRole === 'readonly') bar.dataset.mtReadonly = '1';
    const roleLabel = currentUserRole === 'admin' ? 'Admin'
                   : currentUserRole === 'editor' ? 'Editor'
                   : 'Read only';
    bar.innerHTML = `
      <div class="mt-bar-row mt-bar-row-top">
        <label class="mt-bulk-group"><input type="checkbox" class="mt-bulk-select-all"> Select all</label>
        <span class="mt-sep">·</span>
        <span class="mt-selected-count">0 selected</span>
        <span class="mt-sep">·</span>
        <label class="mt-bulk-group">Route
          <select class="mt-bulk-route">
            <option value="">— no change —</option>
            ${ROUTES.map(r => `<option value="${r.value}">${escapeHtml(r.label)}</option>`).join('')}
          </select>
        </label>
        <label class="mt-bulk-group">Status
          <select class="mt-bulk-status">
            <option value="">— no change —</option>
            ${STATUSES.map(s => `<option value="${s.value}">${escapeHtml(s.label)}</option>`).join('')}
          </select>
        </label>
        <label class="mt-bulk-group">Tracking
          <input type="text" class="mt-bulk-track" placeholder="— no change —">
        </label>
        <label class="mt-bulk-group">ETA
          <input type="date" class="mt-bulk-eta" title="Pick a date and click Apply to set ETA on all selected rows">
        </label>
        <label class="mt-bulk-group" title="Tick to clear ETA on selected rows when applying. Overrides the date picker.">
          <input type="checkbox" class="mt-bulk-eta-clear"> Clear ETA
        </label>
        <span class="mt-spacer"></span>
        <button type="button" class="mt-bulk-btn">Apply to Selected</button>
      </div>
      <div class="mt-bar-row mt-bar-row-filters" title="Click a chip to hide rows that don't match. Progress bar still counts the whole cost centre.">
        <span class="mt-bulk-group" style="color:#697783;font-weight:600;">Show:</span>
        <span class="mt-filter-chips">
          <button type="button" class="mt-chip mt-chip-active" data-filter="all">All <span class="mt-chip-count" data-for="all">0</span></button>
          <button type="button" class="mt-chip" data-filter="pending">Pending <span class="mt-chip-count" data-for="pending">0</span></button>
          <button type="button" class="mt-chip" data-filter="transit">In transit <span class="mt-chip-count" data-for="transit">0</span></button>
          <button type="button" class="mt-chip" data-filter="done">Done <span class="mt-chip-count" data-for="done">0</span></button>
          <button type="button" class="mt-chip mt-chip-issue" data-filter="issues">Issues <span class="mt-chip-count" data-for="issues">0</span></button>
        </span>
        <span class="mt-spacer"></span>
        <button type="button" class="mt-cc-log-btn" title="Full change log for this cost centre — all rows including parts later unallocated">📋 CC Log</button>
        <button type="button" class="mt-csv-btn" title="Download the current cost centre's tracking data as a CSV file">⬇ CSV</button>
      </div>
      <div class="mt-bar-row mt-bar-row-bottom">
        <span class="mt-refresh-hint" title="Saves stream in live. Changes persist instantly; no manual save needed.">⚠ Don't refresh — changes save automatically</span>
        <span class="mt-spacer"></span>
        <span class="mt-bulk-group mt-progress-host" title="Weighted progress. Each line contributes:
  Not actioned 0%
  Ordered 10%
  Confirmed 50%
  Shipped / Collected (eng|cust) 60%
  Delivered to WH 70%
  Delivered to site 80%
  Receipt confirmed 100%
  Issue / Returned 0%
Bar % = average weight across all lines.">
          <progress class="mt-progress-native" value="0" max="100"></progress>
          <span class="mt-progress-text">0%</span>
        </span>
        <span class="mt-user-chip">
          <span class="mt-role mt-role-${escapeHtml(currentUserRole || 'readonly')}">${escapeHtml(roleLabel)}</span>
          <span class="mt-user-email"></span>
          ${currentUserRole === 'admin' ? '<button type="button" class="mt-admin-btn">Manage users</button>' : ''}
          <a class="mt-sign-out">sign out</a>
        </span>
      </div>
    `;
    host.insertBefore(bar, table);

    bar.querySelector('.mt-user-email').textContent = currentUser.email || 'signed in';
    bar.querySelector('.mt-sign-out').onclick = () => signOut();
    bar.querySelector('.mt-admin-btn')?.addEventListener('click', openUsersAdminModal);

    const rowChecks = () => [...document.querySelectorAll('#materialsTable tbody tr.assignFromStock[data-mt-injected="1"] .mt-row-check')];
    const headerCheck = () => document.querySelector('#materialsTable thead .mt-select-all');
    const bulkAll = bar.querySelector('.mt-bulk-select-all');

    const updateSelectedCount = () => {
      const n = rowChecks().filter(c => c.checked).length;
      bar.querySelector('.mt-selected-count').textContent = `${n} selected`;
    };
    const setAll = (on) => {
      rowChecks().forEach(c => { c.checked = on; });
      if (headerCheck()) headerCheck().checked = on;
      bulkAll.checked = on;
      updateSelectedCount();
    };
    bulkAll.addEventListener('change', () => setAll(bulkAll.checked));
    if (headerCheck()) headerCheck().addEventListener('change', () => setAll(headerCheck().checked));
    document.getElementById('materialsTable').addEventListener('change', (e) => {
      if (e.target.classList.contains('mt-row-check')) updateSelectedCount();
    });

    // ETA clear toggle: dim the date picker so it's obvious the checkbox wins.
    bar.querySelector('.mt-bulk-eta-clear').addEventListener('change', (ev) => {
      bar.classList.toggle('mt-bulk-eta-clearing', ev.target.checked);
    });

    // Apply bulk — surface first error clearly
    bar.querySelector('.mt-bulk-btn').addEventListener('click', async () => {
      const selectedRows = rowChecks().filter(c => c.checked).map(c => c.closest('tr'));
      if (!selectedRows.length) { toast('No rows selected'); return; }
      const route = bar.querySelector('.mt-bulk-route').value || null;
      const status = bar.querySelector('.mt-bulk-status').value || null;
      const trackingRaw = bar.querySelector('.mt-bulk-track').value;
      const tracking = trackingRaw.trim();
      // ETA: precedence is "Clear ETA" checkbox > date input > no change.
      const etaInputVal = bar.querySelector('.mt-bulk-eta').value;
      const etaClear = bar.querySelector('.mt-bulk-eta-clear').checked;
      let etaTouched = false;
      const changes = {};
      if (route) changes.route = route;
      if (status) changes.status = status;
      if (tracking) changes.tracking_no = tracking;
      if (etaClear) { changes.eta = null; etaTouched = true; }
      else if (etaInputVal) { changes.eta = etaInputVal; etaTouched = true; }
      if (!route && !status && !tracking && !etaTouched) {
        toast('Pick at least one field to apply'); return;
      }
      log('bulk apply', { count: selectedRows.length, changes });

      const btnEl = bar.querySelector('.mt-bulk-btn');
      btnEl.disabled = true; btnEl.textContent = 'Applying…';
      let ok = 0, fail = 0, firstErr = null;
      for (const tr of selectedRows) {
        const recId = tr.dataset.mtRecordId;
        if (!recId) { fail++; continue; }
        tr.classList.remove('mt-error', 'mt-saved');
        tr.classList.add('mt-dirty');
        const safety = setTimeout(() => tr.classList.remove('mt-dirty'), 10000);
        try {
          const saved = await updateRecord(recId, changes);
          // Let the shared refresh path update cache + DOM so all renders stay in sync.
          const cached = recordsRef.byId?.get(recId);
          if (cached) Object.assign(cached, saved);
          else recordsRef.byId.set(recId, saved);
          recordsRef.recordMap.set(
            `${saved.material_id}|${saved.location_id}|${saved.occurrence_index}`,
            cached || saved
          );
          recordsRef.refreshRowUi?.(cached || saved);
          tr.classList.remove('mt-dirty');
          tr.classList.add('mt-saved');
          setTimeout(() => tr.classList.remove('mt-saved'), 900);
          ok++;
        } catch (e) {
          fail++;
          tr.classList.remove('mt-dirty');
          tr.classList.add('mt-error');
          if (!firstErr) firstErr = e;
          err('bulk update', { recId, changes, error: e });
        } finally {
          clearTimeout(safety);
        }
      }
      btnEl.disabled = false; btnEl.textContent = 'Apply to Selected';
      if (fail) {
        const msg = firstErr?.message || firstErr || 'unknown';
        toast(`Updated ${ok}, ${fail} failed: ${msg}`, { error: true });
      } else {
        toast(`Updated ${ok} row${ok===1?'':'s'}`);
      }
      // Repaint every row from the now-fresh cache. Without this, the selects
      // the user interacted with in the bulk bar (which don't fire `change` on
      // the per-row selects) would stay at their pre-apply value until the
      // realtime echo arrives — which the user observed was slow / missing.
      for (const rec of recordsRef.byId.values()) {
        recordsRef.refreshRowUi?.(rec);
      }
      // Clear selection + bulk-bar inputs so the next batch starts clean
      rowChecks().forEach(c => { c.checked = false; });
      if (headerCheck()) headerCheck().checked = false;
      bulkAll.checked = false;
      updateSelectedCount();
      bar.querySelector('.mt-bulk-route').value = '';
      bar.querySelector('.mt-bulk-status').value = '';
      bar.querySelector('.mt-bulk-track').value = '';
      bar.querySelector('.mt-bulk-eta').value = '';
      bar.querySelector('.mt-bulk-eta-clear').checked = false;
      bar.classList.remove('mt-bulk-eta-clearing');
      onRefresh?.();
      // Re-apply current filter in case statuses moved rows in/out of the view.
      filterApi?.reapply?.();
    });

    // ─────────────────────────────────────────────────────────────────────
    // FILTER CHIPS — hide rows whose status doesn't match the selected chip.
    // The progress bar is NOT scoped to the filter; it always represents the
    // whole cost centre so staff can see overall readiness while drilling
    // into one slice of work.
    // ─────────────────────────────────────────────────────────────────────
    const FILTER_STATUSES = {
      all: null, // show all rows
      pending: new Set(['not_actioned', 'ordered', 'confirmed']),
      transit: new Set(['shipped', 'collected_engineer', 'collected_customer', 'delivered_wh']),
      done: new Set(['delivered', 'receipt_confirmed']),
      issues: new Set(['issue', 'returned']),
    };
    let activeFilter = 'all';
    const chipEls = [...bar.querySelectorAll('.mt-chip')];
    const countEls = Object.fromEntries(
      [...bar.querySelectorAll('.mt-chip-count')].map(el => [el.dataset.for, el])
    );
    // Helper: only the records that are currently rendered on the page. We
    // don't want orphan tracking_records (materials unassigned in SimPro since
    // they were seeded) inflating "All" and tier counts. Same set drives CSV
    // export. v1.6 fix.
    function visibleRecs() {
      const visibleIds = new Set(
        [...document.querySelectorAll('#materialsTable tbody tr[data-mt-record-id]')]
          .map(tr => tr.dataset.mtRecordId)
      );
      return [...recordsRef.byId.values()].filter(r => visibleIds.has(String(r.id)));
    }
    function applyFilter() {
      const wanted = FILTER_STATUSES[activeFilter];
      // Use rowsel from `[data-mt-injected="1"]` (rather than just any data-mt-record-id)
      // so we only touch rows we actually own — never a SimPro row we missed.
      const trs = [...document.querySelectorAll('#materialsTable tbody tr.assignFromStock[data-mt-injected="1"]')];
      let shown = 0, hidden = 0;
      for (const tr of trs) {
        const recId = tr.dataset.mtRecordId;
        const rec = recId ? recordsRef.byId?.get(recId) : null;
        // Defensive: if we have a row but no matching record (transient race
        // during a save echo, or an orphan we still rendered) keep it visible
        // — never silently hide an editable row. v1.6 bugfix: previously this
        // could hide every row when activeFilter wasn't 'all' AND `byId` was
        // momentarily out of sync with the DOM.
        const match = !wanted || !rec || wanted.has(rec.status);
        if (match) {
          if (currentStockTab === 'Allocated' && tr.classList.contains('AllocatedStock')) {
            // On the Allocated tab, only force-show rows that SimPro has formally
            // allocated (AllocatedStock CSS class = stock drawn from inventory for
            // this job). This keeps the Allocated tab faithful to SimPro — it shows
            // exactly what SimPro considers assigned, no more. Non-allocated rows
            // (RequiredStock-only) are hidden by SimPro's .hide class; we must not
            // override that or the tab becomes a dump of all materials.
            tr.style.setProperty('display', 'table-row', 'important');
          } else {
            // All other cases (All tab, Required, In Stock, Order, or non-allocated
            // rows on Allocated tab): remove our display override so SimPro's native
            // tab filtering (.hide → display:none) applies correctly.
            tr.style.removeProperty('display');
          }
          shown++;
        } else {
          // Use !important so SimPro's own row stylesheet rules can't beat us
          // — some SimPro themes ship `tr.assignFromStock { display: ... }`
          // declarations that outranked our plain inline style. v1.6 bugfix:
          // "Filtering does not filter the table" was this exact problem.
          tr.style.setProperty('display', 'none', 'important');
          hidden++;
        }
      }
      log('filter', activeFilter, 'shown:', shown, 'hidden:', hidden);
    }
    function updateChipCounts() {
      // v1.6: count ON-PAGE records only — orphan tracking_records don't inflate.
      // v1.7.1: also exclude mt-unassigned rows (assigned_qty = 0). Those rows
      // have no meaningful tracking state — showing them in "All 5 / Pending 5"
      // when none of them can be edited is confusing. They are still shown in the
      // table (greyed-out) and appear in CSV; they just don't count toward chips.
      const recs = visibleRecs().filter(r => {
        const tr = document.querySelector(
          `#materialsTable tbody tr[data-mt-record-id="${r.id}"]`
        );
        return tr && !tr.classList.contains('mt-unassigned');
      });
      const counts = { all: recs.length, pending: 0, transit: 0, done: 0, issues: 0 };
      for (const r of recs) {
        for (const [key, set] of Object.entries(FILTER_STATUSES)) {
          if (set && set.has(r.status)) counts[key]++;
        }
      }
      for (const [key, el] of Object.entries(countEls)) {
        el.textContent = String(counts[key] ?? 0);
      }
    }
    chipEls.forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.preventDefault(); // bar lives outside SimPro's <form>, but be safe
        e.stopPropagation();
        activeFilter = chip.dataset.filter;
        chipEls.forEach(c => c.classList.toggle('mt-chip-active', c === chip));
        applyFilter();
      });
    });
    updateChipCounts();
    // Expose reapply/refreshCounts so refreshRowUi + per-row saves can keep the
    // view consistent when a row's status changes.
    const api = {
      reapply: () => { updateChipCounts(); applyFilter(); },
      refreshCounts: updateChipCounts,
    };
    Object.assign(filterApi, api);

    // ─────────────────────────────────────────────────────────────────────
    // CC LOG — full audit trail for every tracking record in this cost centre,
    // including lines that were later unallocated (while the parent record
    // still exists in tracking_records).
    // ─────────────────────────────────────────────────────────────────────
    bar.querySelector('.mt-cc-log-btn').addEventListener('click', () => openCCLogModal(ctx));

    // ─────────────────────────────────────────────────────────────────────
    // CSV EXPORT — one row per tracking record. Uses RFC-4180 quoting so
    // commas / quotes / newlines in material names or notes don't corrupt
    // the output. Encoded with a UTF-8 BOM so Excel opens it cleanly.
    // ─────────────────────────────────────────────────────────────────────
    bar.querySelector('.mt-csv-btn').addEventListener('click', async () => {
      // Only export records that are CURRENTLY rendered as rows in the SimPro
      // table. Without this filter the CSV also dumps "orphan" tracking_records
      // — rows for materials that have been unassigned/removed in SimPro since
      // they were first seeded — which show up as empty-material lines and
      // confuse downstream spreadsheets. (See v1.6 bug report.)
      const visibleIds = new Set(
        [...document.querySelectorAll('#materialsTable tbody tr[data-mt-record-id]')]
          .map(tr => tr.dataset.mtRecordId)
      );
      const recs = [...recordsRef.byId.values()].filter(r => visibleIds.has(String(r.id)));
      if (!recs.length) { toast('Nothing to export — no tracked rows visible.'); return; }
      const ROUTE_LABEL = Object.fromEntries(ROUTES.map(r => [r.value, r.label]));
      const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.value, s.label]));
      const esc = v => {
        const s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      // ── Timestamp formatter: ISO 8601 → "DD/MM/YYYY HH:MM" (local time) ──
      const fmtTs = iso => {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d)) return iso;
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };

      // ── UUID → email map via user_profiles ──────────────────────────────
      // Falls back to bare UUID if the fetch fails or the profile is missing.
      // Also populates the global userEmailCache so audit modals opened later
      // in the same session show full email addresses immediately.
      const emailMap = {};
      try {
        const { data: profiles } = await sb.from('user_profiles').select('user_id, email');
        if (profiles) profiles.forEach(p => {
          if (p.email) {
            emailMap[p.user_id] = p.email;
            userEmailCache.set(p.user_id, p.email); // warm global cache
          }
        });
      } catch (e) { warn('CSV email lookup failed', e); }

      // ── DOM name lookup (authoritative — beats stale DB values) ──────────
      // The DB may hold wrong data from the pre-v1.6.4 seeding bug (e.g.
      // location_name = "Receipt Confirmed" because cells[8] was read on an
      // already-injected row where cell indices had shifted). Read from the
      // live DOM instead; it always reflects the current page state.
      //
      // After injectRowCells runs, every row has a leading checkbox <td> at
      // index 0 (shifting all original SimPro cells by +1), and 5 MT cells
      // inserted mid-row. We detect this via row.dataset.mtInjected and
      // apply an offset (off = 1) so we still read the right original cells.
      // Sub-row detection: the original cells[0] is an empty colspan=8 <td>;
      // after injection it lives at cells[off] — check its colSpan attribute.
      const domNames = new Map(); // "material_id|location_id" => {material_name, location_name}
      {
        let lastDomMat = null;
        for (const row of document.querySelectorAll('#materialsTable tbody tr.assignFromStock')) {
          const si = row.querySelector('input[name^="stock["]');
          if (!si) continue;
          const mm = si.name.match(/^stock\[(\d+)\]\[(\d+)\]$/);
          if (!mm) continue;
          const cells = [...row.querySelectorAll('td')];
          const injected = !!row.dataset.mtInjected;
          const off = injected ? 1 : 0; // checkbox at [0] shifts original cells by 1
          const isSubRow = injected
            ? (cells[off]?.colSpan || 1) > 1 // original cells[0] is colspan=8 for sub-rows
            : cells.length < 10;
          const rawMat = (cells[off]?.innerText || '').trim();
          if (!isSubRow && rawMat) lastDomMat = rawMat.slice(0, 300);
          const mat = isSubRow ? lastDomMat : (rawMat.slice(0, 300) || null);
          // Sub-row location = cells[off+1] (Stored At label).
          // Main-row location = cells[off+8] (warehouse name column).
          const loc = isSubRow
            ? (cells[off + 1]?.innerText || '').trim() || null
            : (cells[off + 8]?.innerText || '').trim() || null;
          domNames.set(`${mm[1]}|${mm[2]}`, { material_name: mat, location_name: loc });
        }
      }

      // "Material Code" was dropped in v1.6: SimPro renders the code inside the
      // material-name cell ("0448003200 Impel FBV…"), and the script never had
      // a separate code field, so the column was always blank.
      const header = [
        'Material', 'Location',
        'Required', 'Assigned',
        'Route', 'Tracking No.', 'ETA', 'Status',
        'Notes', 'Updated At', 'Updated By',
      ];
      const lines = [header.map(esc).join(',')];
      // Sort by material name then location for a readable spreadsheet.
      recs.sort((a, b) => (a.material_name || '').localeCompare(b.material_name || '')
                      || (a.location_name || '').localeCompare(b.location_name || ''));
      for (const r of recs) {
        const dom = domNames.get(`${r.material_id}|${r.location_id}`) || {};
        // Prefer DOM values: they are read from the live page and are always
        // correct. The DB values can be stale or wrong (e.g. location_name
        // seeded as "Receipt Confirmed" due to the pre-v1.6.4 parsing bug).
        lines.push([
          dom.material_name || r.material_name || '',
          dom.location_name || r.location_name || '',
          r.required_qty, r.assigned_qty,
          ROUTE_LABEL[r.route] || r.route || '',
          r.tracking_no,
          r.eta || '',
          STATUS_LABEL[r.status] || r.status || '',
          r.notes,
          fmtTs(r.updated_at),
          emailMap[r.updated_by] || r.updated_by || '',
        ].map(esc).join(','));
      }
      const csv = '\uFEFF' + lines.join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '');
      a.href = url;
      a.download = `materials-tracking-job${recs[0]?.job_id || 'x'}-cc${recs[0]?.cost_centre_id || 'x'}-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
      toast(`Exported ${recs.length} row${recs.length===1?'':'s'} to CSV`);
    });

    return bar;
  }

  // Per-status progress weight (per Pawel's spec):
  // Not actioned → 0%
  // Ordered → 10%
  // Confirmed (order confirmed)→ 50%
  // Shipped / Collected (eng|cust)→ 60% (in-transit — between confirmed and delivered)
  // Delivered to WH → 70% (arrived at warehouse, pending onward delivery to site)
  // Delivered to site → 80%
  // Receipt confirmed → 100%
  // Issue / Returned → 0%
  // Total % = sum(weights) / lines.
  const STATUS_WEIGHT = {
    not_actioned: 0,
    ordered: 0.10,
    confirmed: 0.50,
    shipped: 0.60,
    collected_engineer: 0.60,
    collected_customer: 0.60,
    delivered_wh: 0.70,
    delivered: 0.80,
    receipt_confirmed: 1.00,
    issue: 0,
    returned: 0,
  };
  function computeProgressPct(records) {
    // Only count rows that have stock assigned (qty > 0). Rows with no
    // assigned quantity carry the mt-unassigned class and represent materials
    // not yet pulled from stock — including them would dilute the percentage
    // with lines that have no meaningful tracking state.
    const active = records.filter(r => {
      const row = document.querySelector(
        `#materialsTable tbody tr[data-mt-record-id="${r.id}"]`
      );
      return row && !row.classList.contains('mt-unassigned');
    });
    const total = active.length;
    if (!total) return 0;
    const weighted = active.reduce((sum, r) => sum + (STATUS_WEIGHT[r.status] ?? 0), 0);
    return Math.round(100 * weighted / total);
  }
  function renderProgress(bar, records) {
    if (!bar) return;
    const pct = computeProgressPct(records);
    log('renderProgress', pct + '%', 'across', records.length, 'records');
    const prog = bar.querySelector('progress.mt-progress-native');
    const txt = bar.querySelector('.mt-progress-text');
    if (prog) prog.value = pct;
    if (txt) txt.textContent = pct + '%';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. REALTIME
  // ═══════════════════════════════════════════════════════════════════════════
  function subscribeRealtime(ctx, onChange) {
    const channel = sb.channel(`cc-${ctx.jobID}-${ctx.costCentreID}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'tracking_records',
        filter: `cost_centre_id=eq.${ctx.costCentreID}`,
      }, payload => {
        if (payload.new?.job_id !== ctx.jobID && payload.old?.job_id !== ctx.jobID) return;
        onChange(payload);
      })
      .subscribe(status => log('realtime:', status));
    window.addEventListener('beforeunload', () => { sb.removeChannel(channel); });
    return channel;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. BOOTSTRAP — cost-centre edit page
  // ═══════════════════════════════════════════════════════════════════════════
  async function bootstrapCostCentreEdit() {
    log('bootstrap: cost-centre edit');
    let table;
    try {
      table = await waitFor(() => document.getElementById('materialsTable'));
    } catch { log('no materialsTable — exiting'); return; }

    const ctx = extractCostCentreContext();
    if (!ctx.jobID || !ctx.costCentreID || !ctx.sectionID) {
      warn('missing page context — cannot proceed', ctx);
      return;
    }
    log('context', ctx);

    const rows = parseAllocationRows(table);
    if (!rows.length) { log('no allocation rows on this page'); return; }
    log('parsed', rows.length, 'rows');

    const user = await ensureAuth();
    if (!user) { log('user cancelled sign-in'); return; }

    let recordMap;
    try { recordMap = await ensureRecords(ctx, rows); }
    catch (e) { err('sync failed', e); toast('Sync failed: ' + e.message, { error: true }); return; }

    injectHeaders(table);

    // Use `let` for bar so closures that reference it don't TDZ-trip before assignment.
    let bar = null;
    // filterApi is populated by injectBulkBar via Object.assign — it's an empty
    // object until then, so refreshRowUi can call filterApi.reapply?.() safely.
    const filterApi = {};

    // recordsRef lets the per-row + bulk-bar handlers update cached records + repaint.
    const recordsRef = {
      byId: new Map([...recordMap.values()].map(r => [r.id, r])),
      recordMap,
      pageCtx: ctx, // page context (jobID / costCentreID / sectionID)
      onRecordSaved: (saved) => {
        const cached = recordsRef.byId.get(saved.id);
        if (cached) Object.assign(cached, saved); else recordsRef.byId.set(saved.id, saved);
        const k = `${saved.material_id}|${saved.location_id}|${saved.occurrence_index}`;
        recordMap.set(k, cached || saved);
        refreshRowUi(saved);
        renderProgress(bar, allRecords());
      }
    };
    const allRecords = () => [...recordMap.values()].filter(r =>
      String(r.cost_centre_id) === String(ctx.costCentreID) &&
      String(r.job_id) === String(ctx.jobID)
    );

    // Re-write the per-row controls from the latest saved record. Called from onRecordSaved,
    // bulk apply, and realtime — so the DOM never drifts away from the DB.
    //
    // We iterate <option>s explicitly (instead of `select.value = X`) because
    // setting `.value` sometimes no-ops if the browser hadn't finished parsing
    // the option list at build time, leaving the displayed selection stuck on
    // the old value. Looping option.selected is the bullet-proof pattern.
    function setSelectValue(sel, val) {
      const want = val == null ? '' : String(val);
      let matched = false;
      for (const opt of sel.options) {
        const on = opt.value === want;
        if (on) matched = true;
        if (opt.selected !== on) opt.selected = on;
      }
      if (!matched && sel.options.length) sel.selectedIndex = 0;
    }
    function refreshRowUi(rec) {
      const tr = document.querySelector(`#materialsTable tr[data-mt-record-id="${rec.id}"]`);
      if (!tr) return;
      const routeSel = tr.querySelector('.mt-route');
      const statusSel = tr.querySelector('.mt-status');
      const trackInp = tr.querySelector('.mt-track');
      const trackCopy = tr.querySelector('.mt-track-copy');
      const etaInp = tr.querySelector('.mt-eta');
      // Route + Status: always re-sync, even if the element is focused.
      // The previous code skipped the update when document.activeElement
      // happened to equal the select, which occasionally masked bulk-apply
      // updates behind stale option text.
      if (routeSel) setSelectValue(routeSel, rec.route || '');
      if (statusSel) { setSelectValue(statusSel, rec.status); applyStatusTier(statusSel, rec.status); }
      if (trackInp && document.activeElement !== trackInp) {
        trackInp.value = rec.tracking_no || '';
      }
      if (trackCopy) trackCopy.disabled = !rec.tracking_no;
      if (etaInp && document.activeElement !== etaInp) {
        etaInp.value = rec.eta || '';
        applyEtaClass(etaInp, rec.eta, rec.status);
      } else if (etaInp) {
        applyEtaClass(etaInp, etaInp.value, rec.status);
      }
      // Re-apply current filter so the row stays hidden/shown after status change.
      filterApi?.reapply?.();
    }
    recordsRef.refreshRowUi = refreshRowUi;

    const rowsById = new Map();
    // Start stripeIdx at 1 so the FIRST data row gets mt-row-odd (the tinted
    // background). Our header is white, so leading with a tinted row means
    // the first row is immediately distinguishable from the header strip
    // above it — previously both were white and blended into one visual band.
    let stripeIdx = 1;
    const STRIPE_ODD = '#eef2f7';
    const STRIPE_EVEN = '#ffffff';
    for (const r of rows) {
      // Always stripe the row FIRST — even rows without a tracking record (e.g.
      // newly added allocations not yet synced) get a stripe so the visible
      // pattern never breaks with clusters of 3.
      const isOdd = stripeIdx % 2 === 1;
      r.row.classList.add(isOdd ? 'mt-row-odd' : 'mt-row-even');
      // Belt + braces — in addition to the stylesheet rule (which SimPro
      // occasionally outranks with its own !important declarations), we set
      // each TD's backgroundColor inline with !important. Inline !important
      // beats every external stylesheet rule regardless of specificity.
      for (const td of r.row.children) {
        if (td.tagName === 'TD') {
          td.style.setProperty('background-color', isOdd ? STRIPE_ODD : STRIPE_EVEN, 'important');
        }
      }
      stripeIdx++;
      const rec = recordMap.get(`${r.material_id}|${r.location_id}|${r.occurrence_index}`);
      if (!rec) continue;
      injectRowCells(r, rec, updateRecord, recordsRef);
      rowsById.set(rec.id, r);
    }
    log('striped', stripeIdx, 'allocation rows');

    // ── Post-injection assigned-state re-check ────────────────────────────────
    // SimPro sometimes initialises stock-input values asynchronously (its own JS
    // fires around document-idle, creating a race with our parseAllocationRows).
    // If we parsed before SimPro set the values, every row read assigned_qty=null
    // and was marked mt-unassigned — MT cells grayed-out for one user while fine
    // for another on the same page. Re-read each input after a short delay; if
    // the value has since changed, lift or apply mt-unassigned accordingly.
    // Two passes (300 ms + 1500 ms) cover fast inline-JS and slower AJAX init.
    function recheckAssignedState() {
      let changed = 0;
      for (const r of rows) {
        const inp = r.row.querySelector('input[name^="stock["]');
        if (!inp) continue;
        const freshQty = parseFloat(inp.value || '') || null;
        // Mirror the same dual-condition used in injectRowCells: a row is only
        // unassigned when BOTH the stock spinner AND the in_stock_qty are absent.
        const shouldBeUnassigned = !freshQty && !r.in_stock_qty;
        const isUnassigned = r.row.classList.contains('mt-unassigned');
        if (isUnassigned !== shouldBeUnassigned) {
          r.row.classList.toggle('mt-unassigned', shouldBeUnassigned);
          // Sync disabled state on interactive MT controls in this row.
          const rdonly = currentUserRole === 'readonly';
          r.row.querySelector('input.mt-row-check')?.toggleAttribute('disabled', rdonly || shouldBeUnassigned);
          r.row.querySelectorAll('td.mt-cell select').forEach(s => {
            s.disabled = rdonly || shouldBeUnassigned;
          });
          changed++;
        }
      }
      if (changed) log('assigned-state re-check updated', changed, 'row(s)');
    }
    setTimeout(recheckAssignedState, 300);
    setTimeout(recheckAssignedState, 1500);

    bar = injectBulkBar({
      records: allRecords(),
      recordsRef,
      onRefresh: () => renderProgress(bar, allRecords()),
      filterApi,
      ctx,
    });
    renderProgress(bar, allRecords());
    // First-time filter pass so chip counts show the real totals straight away.
    filterApi.reapply?.();

    // ── Stock sub-tab awareness ───────────────────────────────────────────────
    // MT columns + bulk bar are shown on the "Allocated" and "All" sub-tabs.
    // • Allocated: shows only SimPro-assigned rows (AllocatedStock class).
    // • All: shows all rows including unallocated stock — the working tab
    // for fresh jobs where nothing has been formally drawn yet.
    // Required / In Stock / Order views remain uncluttered (MT columns hidden).
    const STOCK_SUB_TABS = new Set(['All', 'Required', 'Allocated', 'In Stock', 'Order']);
    function syncAllocatedView() {
      currentStockTab = [...document.querySelectorAll('a.subTab')]
        .find(a => STOCK_SUB_TABS.has(a.querySelector('span')?.textContent.trim()) && a.classList.contains('current'))
        ?.querySelector('span')?.textContent.trim() || 'All';
      // MT columns and bulk bar visible on both Allocated and All tabs.
      const isMtActive = currentStockTab === 'Allocated' || currentStockTab === 'All';
      table.classList.toggle('mt-allocated-active', isMtActive);
      if (bar) bar.style.display = isMtActive ? '' : 'none';
      // Always clear inline background-color from native TDs first, then
      // re-stripe only the rows that are visible after SimPro's tab filtering
      // and applyFilter (called at the end) have settled. setTimeout(0) ensures
      // the DOM display changes from applyFilter are committed before we read
      // getComputedStyle — this is correct for every tab including Allocated
      // (which now only shows a subset of rows: those with AllocatedStock class).
      for (const td of table.querySelectorAll(
        'tbody tr:is(.mt-row-odd,.mt-row-even) > td:not(.mt-cell):not(.mt-check)'
      )) {
        td.style.removeProperty('background-color');
      }
      setTimeout(() => {
        let si = 1;
        for (const tr of table.querySelectorAll('tbody tr.assignFromStock')) {
          if (window.getComputedStyle(tr).display === 'none') continue;
          const isOdd = si % 2 === 1;
          for (const td of tr.children) {
            if (td.tagName === 'TD' && !td.classList.contains('mt-cell') && !td.classList.contains('mt-check'))
              td.style.setProperty('background-color', isOdd ? STRIPE_ODD : STRIPE_EVEN, 'important');
          }
          si++;
        }
      }, 0);
      filterApi.reapply?.();
    }
    const stockTabLinks = [...document.querySelectorAll('a.subTab')]
      .filter(a => STOCK_SUB_TABS.has(a.querySelector('span')?.textContent.trim()));
    const stockSubTabObserver = new MutationObserver(syncAllocatedView);
    stockTabLinks.forEach(a => stockSubTabObserver.observe(a, { attributes: true, attributeFilter: ['class'] }));
    syncAllocatedView(); // set initial state on page load

    subscribeRealtime(ctx, payload => {
      const n = payload.new, o = payload.old;
      const rec = n || o;
      if (!rec) return;
      if (payload.eventType === 'DELETE') {
        // Only evict from recordMap if the key still holds the same deleted record.
        // If the admin delete handler already re-seeded a fresh record at this key,
        // the key will hold a different ID — we must NOT clobber it.
        const k = `${o.material_id}|${o.location_id}|${o.occurrence_index}`;
        if (recordMap.get(k)?.id === o.id) recordMap.delete(k);
        recordsRef.byId.delete(o.id);
      } else {
        // Mutate in place so per-row closures see updates without a DOM rewrite.
        const existing = recordsRef.byId.get(n.id);
        if (existing) Object.assign(existing, n);
        else recordsRef.byId.set(n.id, n);
        recordMap.set(`${n.material_id}|${n.location_id}|${n.occurrence_index}`, existing || n);
        refreshRowUi(existing || n);
      }
      renderProgress(bar, allRecords());
    });

    // ── Resilience: re-inject after SimPro re-renders the table ─────────────
    // SimPro's timer-based autosave can AJAX-refresh the materials tbody,
    // wiping every injected <td> and data-mt-* attribute. We watch for the
    // pattern "SimPro rows are present but none have data-mt-injected=1" and
    // re-inject automatically — the user should never need to reload the page.
    const reinjectAfterRefresh = debounce((mutations) => {
      const liveTable = document.getElementById('materialsTable');
      if (!liveTable) return;
      const simproRows = liveTable.querySelectorAll('tbody tr.assignFromStock').length;
      if (simproRows === 0) return;
      const ourRows = liveTable.querySelectorAll('tbody tr.assignFromStock[data-mt-injected="1"]').length;
      if (ourRows === 0) {
        // Full re-render: SimPro replaced the tbody content — re-inject everything.
        log('SimPro refreshed the materials table — re-injecting', simproRows, 'rows');
        injectHeaders(liveTable);
        let si = 1;
        const freshParsed = parseAllocationRows(liveTable);
        for (const r of freshParsed) {
          const isOdd = si % 2 === 1;
          r.row.classList.add(isOdd ? 'mt-row-odd' : 'mt-row-even');
          for (const td of r.row.children) {
            if (td.tagName === 'TD')
              td.style.setProperty('background-color', isOdd ? STRIPE_ODD : STRIPE_EVEN, 'important');
          }
          si++;
          const rec = recordMap.get(`${r.material_id}|${r.location_id}|${r.occurrence_index}`);
          if (!rec) continue;
          injectRowCells(r, rec, updateRecord, recordsRef);
        }
        renderProgress(bar, allRecords());
      }
      // If SimPro replaced the entire table CONTAINER (not just the tbody),
      // the bulk bar's parent was wiped and the bar is now disconnected from
      // the DOM — it won't appear even though the rows re-injected fine.
      // Detect this via bar.isConnected and re-inject into the new parent.
      if (bar && !bar.isConnected) {
        const newHost = liveTable.parentElement;
        if (newHost) {
          log('bulk bar disconnected — re-injecting into new table container');
          delete newHost.dataset.mtBulkInjected;
          bar = injectBulkBar({
            records: allRecords(), recordsRef,
            onRefresh: () => renderProgress(bar, allRecords()),
            filterApi, ctx,
          });
          renderProgress(bar, allRecords());
          syncAllocatedView(); // re-apply tab visibility after bar re-inject
        }
      }
      // Always sync tab state after any mutation — this re-asserts display
      // overrides on the Allocated tab, clears inline stripe overrides on
      // other tabs, and re-applies the active filter chip.
      syncAllocatedView();
    }, 250);
    const tbody = table.querySelector('tbody');
    // Wrap the debounced callback so we can filter mutations before debouncing.
    // We react to:
    // (a) childList changes on tbody/parent — SimPro replaced rows (full re-render)
    // (b) class attribute changes on <tr> elements — SimPro added/removed `hide`
    // without replacing DOM (partial autosave re-render)
    // We deliberately ignore attribute changes on child elements (td, select, input)
    // so our own per-row control state changes don't cause feedback loops.
    const tableResilienceObserver = new MutationObserver(mutations => {
      const relevant = mutations.some(m =>
        m.type === 'childList' ||
        (m.type === 'attributes' && m.target.tagName === 'TR' && m.attributeName === 'class')
      );
      if (relevant) reinjectAfterRefresh(mutations);
    });
    if (tbody) {
      // childList catches full row replacement; attributes catches hide-class toggling.
      tableResilienceObserver.observe(tbody, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    // Also watch the table's parent in case SimPro replaces the whole <table>.
    tableResilienceObserver.observe(table.parentElement || table, { childList: true });
    // ── Fallback poll ─────────────────────────────────────────────────────────
    // The MutationObserver can miss a re-render if SimPro replaces the <tbody>
    // element itself rather than its children (the observer was attached to the
    // old element reference which is now detached from the DOM). The poll below
    // catches any injection-loss the observer missed and re-triggers re-injection.
    const resiliencePoll = setInterval(() => {
      const liveTable = document.getElementById('materialsTable');
      if (!liveTable) return;
      const simproRows = liveTable.querySelectorAll('tbody tr.assignFromStock').length;
      if (simproRows === 0) return; // no SimPro rows present yet
      const ourRows = liveTable.querySelectorAll('tbody tr.assignFromStock[data-mt-injected="1"]').length;
      if (ourRows === 0) {
        log('poll: injection lost — re-injecting (observer missed the re-render)');
        reinjectAfterRefresh([]);
      }
    }, 1500);
    window.addEventListener('beforeunload', () => {
      clearInterval(resiliencePoll);
      tableResilienceObserver.disconnect();
    });

    log('ready');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. JOB LIST PAGE — per-cost-centre materials progress bar under "Invoiced"
  // ═══════════════════════════════════════════════════════════════════════════
  async function bootstrapJobList() {
    log('bootstrap: job list');
    const ctx = extractJobListContext();
    if (!ctx.jobID) { log('no jobID on job list page — exiting'); return; }

    // Don't prompt the user to sign in on the list page. If not authed yet, bail silently —
    // the cost-centre edit page handles login.
    const user = await ensureAuth({ requireInteractive: false });
    if (!user) { log('not authed; skipping list-page enrichment'); return; }

    // Pull aggregated progress for this job from the cost_centre_progress view.
    // We then have to map by cost-centre NAME (the list page doesn't expose the
    // underlying numeric cost_centre_id, so we cross-reference via tracking_records).
    const { data: progress, error: pErr } = await sb
      .from('cost_centre_progress')
      .select('*')
      .eq('job_id', ctx.jobID);
    if (pErr) { warn('progress fetch failed', pErr); return; }
    if (!progress?.length) { log('no tracking records for job ' + ctx.jobID); return; }

    // Get a representative cost_centre_name for each cost_centre_id to map back to UI
    const { data: named, error: nErr } = await sb
      .from('tracking_records')
      .select('cost_centre_id, cost_centre_name, status')
      .eq('job_id', ctx.jobID);
    if (nErr) { warn('name fetch failed', nErr); return; }

    // Build { normalisedName -> { total, weighted, issues, name } } using tier weights
    const aggByName = new Map();
    // Display names on the list page look like:
    // "ASHP Installation R3 - 1669 (#4691-41206)"
    // "BUS Grant Refund £X After Installation (01-1)"
    // We strip the trailing "(...)" chunk AND a trailing " - <digits>" CC-number
    // suffix, because the breadcrumb on the edit page gives us just the base name.
    const normName = (s) => String(s || '')
      .toLowerCase()
      .replace(/\s*\(\s*#?\s*[\d/\-\s]+\)\s*$/, '') // strip "(#4691-41206)" / "(01-1)" / "(5)"
      .replace(/\s*-\s*\d+\s*$/, '') // strip trailing " - 1669"
      .replace(/[–—]/g, '-') // normalise en/em dashes to -
      .replace(/\s+/g, ' ')
      .trim();
    for (const rec of named) {
      const key = normName(rec.cost_centre_name);
      if (!key) continue;
      if (!aggByName.has(key)) aggByName.set(key, { total: 0, weighted: 0, issues: 0, name: rec.cost_centre_name });
      const a = aggByName.get(key);
      a.total++;
      a.weighted += STATUS_WEIGHT[rec.status] ?? 0;
      const tier = STATUS_BY_VALUE[rec.status]?.tier ?? 0;
      if (tier === 9) a.issues++;
    }
    log('job-list: aggregated names', [...aggByName.keys()]);

    // ─────────────────────────────────────────────────────────────────────
    // Find CC containers on the project page.
    //
    // The project page renders each cost-centre as a block with two visual
    // tiers:
    // ┌──────────────────────────────────────────────────────────────┐
    // │ [🔒] ASHP Installation R3 - 1669 (#4691-41206) │ ← title line
    // │ │
    // │ Invoiced: 50.00% ▓▓▓░░ Stage: In Progress Total: £… │ ← Invoiced row
    // └──────────────────────────────────────────────────────────────┘
    //
    // SimPro has shipped several markups for this — `th.openCostCentre`,
    // `.fieldHeader`, plain nested divs — so rather than pinning to any
    // single class we detect the block by its CONTENT: any element that
    // contains both "Invoiced:" and either "Stage:" or "Total:" is a CC
    // block. We then de-duplicate by picking the *smallest* such ancestor
    // (so we don't accidentally pick the whole page).
    // ─────────────────────────────────────────────────────────────────────
    const findCcContainers = () => {
      // Fast path: the primary SimPro selector, if present.
      const primary = [...document.querySelectorAll('th.openCostCentre, .openCostCentre')];
      if (primary.length) return primary;

      // Fallback: content-driven detection.
      const all = [...document.querySelectorAll('div, li, section, article, tr, td, th')];
      const candidates = [];
      for (const el of all) {
        if (el.children.length === 0) continue; // skip leaves
        if (el.children.length > 60) continue; // skip page-scale containers
        const txt = el.innerText || '';
        if (!/\bInvoiced:/i.test(txt)) continue;
        if (!/\bStage:/i.test(txt) && !/\bTotal:/i.test(txt)) continue;
        candidates.push(el);
      }
      // Keep only the smallest ancestor per Invoiced occurrence (fewest chars).
      candidates.sort((a, b) => (a.innerText?.length || 0) - (b.innerText?.length || 0));
      const picked = [];
      for (const c of candidates) {
        if (picked.some(p => p.contains(c) || c.contains(p))) continue;
        picked.push(c);
      }
      return picked;
    };

    try {
      await waitFor(() => findCcContainers().length > 0);
    } catch { log('no cost-centre list rendered'); return; }

    const ccContainers = findCcContainers();
    log('job-list: found', ccContainers.length, 'cost-centre container(s)');
    let injected = 0, skippedNoMatch = 0, skippedNoInvoiced = 0;
    for (const th of ccContainers) {
      if (th.dataset.mtJlInjected) continue;

      // ── CC NAME MATCH ────────────────────────────────────────────────
      // Try every text-bearing element within the container — pick the first
      // whose normalised text matches a CC name we have tracking data for.
      const spans = [...th.querySelectorAll('span, a, h1, h2, h3, h4, strong, b, label, div')];
      let match = null, matchText = null, matchKey = null;
      for (const s of spans) {
        const txt = (s.textContent || '').trim();
        if (!txt || txt.length > 200) continue;
        const key = normName(txt);
        if (aggByName.has(key)) {
          match = aggByName.get(key); matchText = txt; matchKey = key; break;
        }
      }
      if (!match) {
        // Last resort: whole-container substring match.
        const containerText = (th.innerText || '').toLowerCase();
        for (const [key, agg] of aggByName) {
          if (containerText.includes(key)) { match = agg; matchKey = key; matchText = key; break; }
        }
      }
      if (!match) {
        log('job-list: no data for CC', (th.innerText || '').slice(0, 80).replace(/\n/g,' '),
            '— available keys:', [...aggByName.keys()].slice(0, 5));
        th.dataset.mtJlInjected = '1';
        skippedNoMatch++;
        continue;
      }
      const agg = match;
      const pct = agg.total ? Math.round(100 * agg.weighted / agg.total) : 0;
      log('job-list: matched', matchText, '→ key', matchKey, '→', pct + '%');

      // ── INVOICED ROW DETECTION ───────────────────────────────────────
      // Find the smallest element inside the container that mentions
      // "Invoiced:" but NOT "Stage:" / "Total:" / "Materials:". That's the
      // Invoiced *cell* (label + % + mini progress). Its parent is the
      // horizontal row carrying Invoiced / Stage / Total.
      const invoicedCandidates = [...th.querySelectorAll('*')].filter(el => {
        const t = (el.innerText || el.textContent || '').trim();
        if (!t) return false;
        if (!/\bInvoiced:/i.test(t)) return false;
        if (/\bStage:/i.test(t)) return false;
        if (/\bTotal:/i.test(t)) return false;
        if (/\bMaterials:/i.test(t)) return false;
        if (el.children.length > 20) return false;
        return true;
      });
      invoicedCandidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      const invoicedCell = invoicedCandidates[0];
      if (!invoicedCell) {
        warn('job-list: no Invoiced cell for', matchText);
        th.dataset.mtJlInjected = '1';
        skippedNoInvoiced++;
        continue;
      }
      const rowParent = invoicedCell.parentElement;
      if (!rowParent) { th.dataset.mtJlInjected = '1'; continue; }

      // ── BUILD + INJECT THE MATERIALS ROW ─────────────────────────────
      // Reuse the row-parent's class so SimPro's flex/grid layout applies
      // to our new row unchanged. Inside, we clone the Invoiced cell's
      // class so the label + progress align horizontally with Invoiced.
      const newRow = document.createElement('div');
      newRow.className = rowParent.className || 'mt-jl-row';
      newRow.dataset.mtJl = '1';
      const cellCls = invoicedCell.className || '';
      newRow.innerHTML = `
        <span class="${escapeHtml(cellCls)} mt-jl-cell">
          <strong>Materials:</strong>
          <progress class="mt-jl-progress" value="${pct}" max="100"
                    title="${agg.total} line${agg.total===1?'':'s'} tracked"></progress>
          <span class="mt-jl-progress-text ${agg.issues ? 'warn' : ''}">
            ${pct}%${agg.issues ? ' · ' + agg.issues + ' issue' + (agg.issues===1?'':'s') : ''}
          </span>
        </span>
      `;
      rowParent.insertAdjacentElement('afterend', newRow);
      th.dataset.mtJlInjected = '1';
      injected++;
    }
    log('job-list: injected progress on', injected, 'cost centre(s) —',
        skippedNoMatch, 'skipped (no records),',
        skippedNoInvoiced, 'skipped (no Invoiced row)');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. BI PAGE — Metabase question overlay (reportbuilder.simprosuite.com)
  //
  // Metabase uses a ReactVirtualized TableInteractive grid — no <table> tags,
  // no ARIA roles. Header cells (.TableInteractive-headerCellData) are in the
  // DOM from page load, so detection is instant (~150 ms first poll). Data
  // cells are absolutely-positioned divs that ReactVirtualized renders only for
  // the ~20 visible rows; the overlay uses position:fixed cells updated via
  // MutationObserver + scroll listener so the "Progress %" column tracks the
  // virtual scroll without touching the containers' overflow or width.
  // ═══════════════════════════════════════════════════════════════════════════
  async function bootstrapBIPage() {
    log('bootstrap: BI page');
    // NOTE: Do NOT call initClient() here.
    // The Supabase JS client auto-initialises and immediately fires
    // _recoverAndRefresh(), which uses fetch() to refresh the auth token.
    // Metabase's CSP blocks that fetch() (connect-src does not whitelist
    // gspkrnqjzabcrufgitdk.supabase.co), flooding the console with CSP errors
    // and causing getSession() to return null.
    //
    // Fix: read the raw session JSON directly from GM storage (synchronous,
    // no network, no CSP risk). If the access token is expiring, refresh it
    // via GM_xmlhttpRequest which runs in Tampermonkey's extension context and
    // is fully CSP-exempt. All subsequent Supabase calls already use
    // GM_xmlhttpRequest for the same reason.

    // ── Auth: read session directly from GM storage (no Supabase client) ────
    let biSession = null;
    try {
      const stored = GM_getValue('mt-auth', null);
      if (stored) biSession = typeof stored === 'string' ? JSON.parse(stored) : stored;
    } catch (e) { /* ignore JSON parse errors */ }

    if (!biSession?.access_token) {
      toast('Materials Tracker: sign in on a SimPro cost-centre page first, then reload this page.');
      log('BI: no session in GM storage — sign in on a SimPro page first');
      return;
    }

    // ── Refresh token if expiring within 60 s (GM_xmlhttpRequest, CSP-exempt) ─
    const nowSecs = Math.floor(Date.now() / 1000);
    if ((biSession.expires_at ?? 0) - nowSecs < 60) {
      log('BI: access token expiring — refreshing via GM_xmlhttpRequest');
      try {
        biSession = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'POST',
            url: SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token',
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            data: JSON.stringify({ refresh_token: biSession.refresh_token }),
            onload: r => {
              if (r.status >= 200 && r.status < 300) {
                const s = JSON.parse(r.responseText);
                GM_setValue('mt-auth', JSON.stringify(s));
                resolve(s);
              } else {
                reject(new Error('Token refresh HTTP ' + r.status));
              }
            },
            onerror: () => reject(new Error('GM_xmlhttpRequest network error')),
          });
        });
      } catch (e) {
        err('BI: token refresh failed', e);
        toast('Materials Tracker: session expired — sign in on a SimPro page and reload.');
        return;
      }
    }

    const biJwt = biSession.access_token;
    currentUser = biSession.user;
    currentUserRole = 'readonly'; // role fetch is CSP-blocked; readonly is safe for BI page
    log('BI: signed in as', currentUser?.email || currentUser?.id);

    // ── Strategy C: Metabase ReactVirtualized / TableInteractive ─────────────
    // Metabase uses class-based virtual-scroll divs — no <table>, no ARIA roles.
    // The header cells are rendered immediately from page load, so detection is
    // essentially instant (first poll ≈150 ms). Data cells are absolutely
    // positioned inside a ReactVirtualized__Grid that only renders ~20 visible
    // rows at a time; we use a MutationObserver + scroll listener to keep the
    // Progress % overlay in sync as the user scrolls.

    // Wait for the header cells (should appear within milliseconds).
    const tableInteractive = await waitFor(
      () => document.querySelector('.TableInteractive-headerCellData')
            ? document.querySelector('.TableInteractive')
            : null,
      { timeout: 10000, interval: 150 }
    ).catch(() => null);

    if (!tableInteractive) {
      log('BI: .TableInteractive not found within 10 s —',
          'body HTML:', document.body.innerHTML.length, 'chars.',
          'Tables:', document.querySelectorAll('table').length,
          '| [role=columnheader]:', document.querySelectorAll('[role="columnheader"]').length);
      return;
    }

    const headerCells = [...tableInteractive.querySelectorAll('.TableInteractive-headerCellData')];
    log('BI: TableInteractive detected —', headerCells.length, 'header col(s):',
        headerCells.map(h => '"' + ((h.querySelector('.cellData') || h).innerText || '').trim() + '"').join(', '));

    // ── Identify the Cost Centre ID column ───────────────────────────────────
    const ccHeaderCell = headerCells.find(h =>
      /cost.?centre.?id|cc.?id|cost_centre_id/i.test(
        ((h.querySelector('.cellData') || h).innerText || '').trim()
      )
    );
    if (!ccHeaderCell) {
      log('BI: CC ID column not found. Headers:',
          headerCells.map(h => '"' + ((h.querySelector('.cellData') || h).innerText || '').trim() + '"').join(', '));
      return;
    }

    // left offset (px) of the CC column — used to match data cells by position
    const ccLeft = parseFloat(ccHeaderCell.style.left) || 0;

    // Progress column sits immediately after the rightmost existing column
    const lastHdrCell = headerCells.reduce((a, b) =>
      (parseFloat(a.style.left) || 0) >= (parseFloat(b.style.left) || 0) ? a : b
    );
    const progressLeft = (parseFloat(lastHdrCell.style.left) || 0)
                       + (parseFloat(lastHdrCell.style.width) || 120);
    const PROG_W = 90; // px width of the injected column
    const cellH = parseFloat(headerCells[0]?.style.height) || 36;

    log('BI: CC col left=' + ccLeft + 'px | progress col left=' + progressLeft + 'px');

    // ── Locate the data grid ─────────────────────────────────────────────────
    const headerGrid = tableInteractive.querySelector(
                            '.ReactVirtualized__Grid.TableInteractive-header');
    const dataGrid = [...tableInteractive.querySelectorAll('.ReactVirtualized__Grid')]
                            .find(g => !g.classList.contains('TableInteractive-header'));
    const dataContainer = dataGrid?.querySelector('.ReactVirtualized__Grid__innerScrollContainer');
    if (!dataGrid || !dataContainer) {
      log('BI: data grid / scroll container not found'); return;
    }
    // Total row count from the innerScrollContainer's full height (used for filter badges)
    const totalRowCount = Math.round(parseFloat(dataContainer.style.height) / cellH) || 0;

    // ── Fetch ALL tracking_records (CSP-exempt via GM_xmlhttpRequest) ─────────
    // fetch() is blocked by Metabase's connect-src CSP. GM_xmlhttpRequest runs
    // in Tampermonkey's extension process and bypasses the page CSP entirely.
    // We fetch all records (no CC filter) because virtual scrolling means we
    // cannot enumerate CC IDs before the user has scrolled through all rows.
    let records;
    try {
      records = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: SUPABASE_URL + '/rest/v1/tracking_records'
              + '?select=cost_centre_id,status,assigned_qty',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + biJwt,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Prefer': 'count=none',
          },
          onload: r => {
            if (r.status >= 200 && r.status < 300) {
              try { resolve(JSON.parse(r.responseText)); }
              catch (e) { reject(new Error('JSON parse: ' + e.message)); }
            } else {
              reject(new Error('HTTP ' + r.status + ': ' + r.responseText));
            }
          },
          onerror: () => reject(new Error('GM_xmlhttpRequest network error')),
        });
      });
    } catch (e) {
      warn('BI: Supabase fetch failed', e.message);
      return;
    }
    log('BI: fetched', records.length, 'tracking records from Supabase');

    // ── Compute weighted progress per CC (assigned rows only) ─────────────────
    const progressByCc = new Map();
    for (const r of (records || [])) {
      const id = r.cost_centre_id;
      if (!progressByCc.has(id)) progressByCc.set(id, { total: 0, weighted: 0 });
      const p = progressByCc.get(id);
      if ((r.assigned_qty ?? 0) > 0) {
        p.total++;
        p.weighted += STATUS_WEIGHT[r.status] ?? 0;
      }
    }

    // ── Progress value helper ──────────────────────────────────────────────────
    // Returns { text, color, pct } — pct is null (no data) or 0-100 integer.
    function biProgressFull(ccId) {
      const p = progressByCc.get(ccId);
      if (!p || p.total === 0) return { text: '—', color: '#9aa5b1', pct: null };
      const pct = Math.round(100 * p.weighted / p.total);
      return {
        text: pct + '%',
        pct,
        color: pct >= 80 ? '#1e6a1e'
             : pct >= 50 ? '#3071a9'
             : pct > 0 ? '#8a5a00'
             : '#697783',
      };
    }

    // ── Active filter state ────────────────────────────────────────────────────
    // biActiveFilter: null = show all | fn(pct: number|null) → true = match
    let biActiveFilter = null;

    // Count how many of the full 3521 rows match the active filter fn
    // (works even though only ~22 rows are rendered in the DOM at any time).
    function countMatchingAllRows(fn) {
      if (!fn) return totalRowCount;
      let n = 0;
      for (const [, d] of progressByCc) {
        const pct = d.total === 0 ? null : Math.round(100 * d.weighted / d.total);
        if (fn(pct)) n++;
      }
      if (fn(null)) n += (totalRowCount - progressByCc.size); // rows with no tracking data
      return n;
    }

    // ── Shared base style for all overlay elements ────────────────────────────
    const OVERLAY_BASE = 'position:fixed;z-index:9999;width:' + PROG_W + 'px;box-sizing:border-box';
    const ROW_DIM_BASE = 'position:fixed;z-index:9998;pointer-events:none';

    // ── Element pool: reuse divs to eliminate flicker during scroll ───────────
    // We never remove pool elements — just update their style or hide them.
    const overlayPool = [];
    function getPoolEl(idx) {
      if (!overlayPool[idx]) {
        const el = document.createElement('div');
        el.className = 'mt-bi-progress';
        el.style.cssText = OVERLAY_BASE + ';display:none;pointer-events:none';
        document.body.appendChild(el);
        overlayPool[idx] = el;
      }
      return overlayPool[idx];
    }

    // ── Row-dim pool: full-width strips that grey out non-matching rows ────────
    const rowDimPool = [];
    function getRowDimEl(idx) {
      if (!rowDimPool[idx]) {
        const el = document.createElement('div');
        el.className = 'mt-bi-row-dim';
        el.style.cssText = ROW_DIM_BASE + ';display:none;background:rgba(235,238,242,0.82)';
        document.body.appendChild(el);
        rowDimPool[idx] = el;
      }
      return rowDimPool[idx];
    }

    // ── Header overlay (interactive: buttons must receive clicks) ─────────────
    document.getElementById('mt-bi-hdr-overlay')?.remove();
    document.getElementById('mt-bi-filter-panel')?.remove();

    const biHdrOverlay = document.createElement('div');
    biHdrOverlay.id = 'mt-bi-hdr-overlay';
    document.body.appendChild(biHdrOverlay);

    // "Progress %" label — shows active filter name when a filter is set
    const biHdrLabel = document.createElement('span');
    biHdrLabel.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    biHdrLabel.textContent = 'Progress %';
    biHdrOverlay.appendChild(biHdrLabel);

    // Filter button ▾
    const biFilterBtn = document.createElement('button');
    biFilterBtn.title = 'Filter by progress';
    biFilterBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:0 2px;font-size:11px;color:#3071a9;line-height:1;flex-shrink:0';
    biFilterBtn.textContent = '▾';
    biHdrOverlay.appendChild(biFilterBtn);

    // CSV download button ↓
    const biCsvBtn = document.createElement('button');
    biCsvBtn.title = 'Export CSV with Progress %';
    biCsvBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:0 3px;font-size:13px;color:#3071a9;line-height:1;flex-shrink:0';
    biCsvBtn.textContent = '↓';
    biHdrOverlay.appendChild(biCsvBtn);

    // ── Filter dropdown panel ─────────────────────────────────────────────────
    const biFilterPanel = document.createElement('div');
    biFilterPanel.id = 'mt-bi-filter-panel';
    biFilterPanel.style.cssText = [
      'position:fixed', 'z-index:10000',
      'background:#fff', 'border:1px solid #d0dce8',
      'border-radius:4px', 'box-shadow:0 4px 12px rgba(0,0,0,.15)',
      'padding:4px 0', 'min-width:130px', 'display:none',
      'font-family:Roboto,Arial,sans-serif', 'font-size:12px',
    ].join(';');
    document.body.appendChild(biFilterPanel);

    const FILTER_OPTIONS = [
      { label: 'All', fn: null },
      { label: '≥ 80%', fn: p => p !== null && p >= 80 },
      { label: '50 – 79%', fn: p => p !== null && p >= 50 && p < 80 },
      { label: '1 – 49%', fn: p => p !== null && p > 0 && p < 50 },
      { label: '0%', fn: p => p === 0 },
      { label: 'No data', fn: p => p === null },
      { label: 'Has data', fn: p => p !== null },
    ];
    FILTER_OPTIONS.forEach(opt => {
      const item = document.createElement('div');
      item.textContent = opt.label;
      item.style.cssText = 'padding:6px 14px;cursor:pointer;color:#24476b';
      item.addEventListener('mouseover', () => { item.style.background = '#eef3f8'; });
      item.addEventListener('mouseout', () => { item.style.background = ''; });
      item.addEventListener('click', () => {
        biActiveFilter = opt.fn;
        const count = countMatchingAllRows(opt.fn);
        biHdrLabel.textContent = opt.fn ? 'Prog: ' + opt.label + ' (' + count + ')' : 'Progress %';
        biHdrLabel.style.color = opt.fn ? '#c05000' : '';
        biFilterPanel.style.display = 'none';
        scheduleUpdate();
      });
      biFilterPanel.appendChild(item);
    });

    biFilterBtn.addEventListener('click', e => {
      e.stopPropagation();
      const r = biHdrOverlay.getBoundingClientRect();
      biFilterPanel.style.left = r.left + 'px';
      biFilterPanel.style.top = (r.bottom + 2) + 'px';
      biFilterPanel.style.display = biFilterPanel.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { biFilterPanel.style.display = 'none'; });

    // ── CSV export ─────────────────────────────────────────────────────────────
    function parseCsvRow(line) {
      const cols = []; let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
        else { cur += ch; }
      }
      cols.push(cur);
      return cols;
    }
    async function exportBiCsv() {
      const cardId = location.pathname.match(/\/question\/(\d+)/)?.[1];
      if (!cardId) { alert('[MT] Cannot read card ID from URL'); return; }
      const origText = biCsvBtn.textContent;
      biCsvBtn.textContent = '…'; biCsvBtn.disabled = true;
      try {
        const resp = await fetch('/api/card/' + cardId + '/query/csv', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const rawCsv = await resp.text();
        const rows = rawCsv.split('\n');
        const hdrCols = parseCsvRow(rows[0] || '');
        const ccCol = hdrCols.findIndex(c => /cost.?centre.?id/i.test(c));

        const out = [rows[0].trimEnd() + ',Progress %'];
        for (let i = 1; i < rows.length; i++) {
          const line = rows[i]; if (!line.trim()) continue;
          let pctText = '—';
          if (ccCol >= 0) {
            const ccId = parseInt(parseCsvRow(line)[ccCol], 10);
            if (!isNaN(ccId)) pctText = biProgressFull(ccId).text;
          }
          out.push(line.trimEnd() + ',' + pctText);
        }
        const blob = new Blob([out.join('\n')], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'),
                       { href: url, download: 'materials-progress-export.csv' });
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
        log('BI: CSV exported —', out.length - 1, 'data rows');
      } catch (e) {
        warn('BI: CSV export failed', e.message);
        alert('[Materials Tracker] CSV export failed: ' + e.message);
      } finally {
        biCsvBtn.textContent = origText; biCsvBtn.disabled = false;
      }
    }
    biCsvBtn.addEventListener('click', e => { e.stopPropagation(); exportBiCsv(); });

    // ── Position header overlay ────────────────────────────────────────────────
    function positionHdrOverlay() {
      const tableRect = tableInteractive.getBoundingClientRect();
      const hdrRect = (headerGrid || tableInteractive).getBoundingClientRect();
      biHdrOverlay.style.cssText = [
        OVERLAY_BASE,
        'pointer-events:all',
        `left:${tableRect.left + progressLeft}px`,
        `top:${hdrRect.top}px`,
        `height:${hdrRect.height || cellH}px`,
        'display:flex', 'align-items:center',
        'padding:0 6px', 'gap:2px',
        'background:#f2f5f8', 'border-left:2px solid #3071a9',
        'font-family:Roboto,Arial,sans-serif',
        'font-size:12px', 'font-weight:700', 'color:#24476b',
      ].join(';');
    }
    positionHdrOverlay();

    // ── Data overlay update: rAF + element pool (no destroy/recreate) ─────────
    // requestAnimationFrame syncs updates with the browser's paint cycle so the
    // overlay never lags behind the scroll position. The element pool eliminates
    // the flicker that occurs when divs are removed and re-added mid-frame.
    let biRafPending = false;
    function updateBiOverlays() {
      biRafPending = false;
      const tableRect = tableInteractive.getBoundingClientRect();
      const fixedLeft = tableRect.left + progressLeft;
      const dataGridRect = dataGrid.getBoundingClientRect();
      // Row-dim strip spans the full visible width of the data grid
      const dimWidth = dataGridRect.width;

      // Find currently-rendered CC data cells (same left offset ±2 px as header)
      const ccCells = [...dataContainer.querySelectorAll('.TableInteractive-cellWrapper')]
        .filter(c => Math.abs((parseFloat(c.style.left) || 0) - ccLeft) < 2);

      for (let i = 0; i < ccCells.length; i++) {
        const cell = ccCells[i];
        const ccId = parseInt((cell.textContent || '').trim(), 10);
        const rect = cell.getBoundingClientRect();
        const el = getPoolEl(i);
        const dimEl = getRowDimEl(i);

        // Hide if off-screen OR scrolled above the data grid (would overlap Metabase nav/header)
        const offScreen = isNaN(ccId) || ccId <= 0
          || rect.bottom <= dataGridRect.top
          || rect.top >= window.innerHeight;
        if (offScreen) {
          el.style.display = 'none';
          dimEl.style.display = 'none';
          continue;
        }

        const { text, color, pct } = biProgressFull(ccId);
        const dimmed = biActiveFilter !== null && !biActiveFilter(pct);

        // ── Progress overlay cell (90 px, right edge of table) ─────────────
        el.style.cssText = [
          OVERLAY_BASE,
          'pointer-events:none',
          `left:${fixedLeft}px`,
          `top:${rect.top}px`,
          `height:${rect.height}px`,
          'display:flex', 'align-items:center', 'justify-content:center',
          'background:#fff',
          'border-left:2px solid #3071a9',
          'font-family:Roboto,Arial,sans-serif', 'font-size:12px',
          `font-weight:${dimmed ? '400' : '600'}`,
          `color:${dimmed ? '#b0bec5' : color}`,
        ].join(';');
        el.textContent = text;

        // ── Full-width row-dim strip for non-matching rows ──────────────────
        if (biActiveFilter !== null && dimmed) {
          dimEl.style.cssText = [
            ROW_DIM_BASE,
            `left:${dataGridRect.left}px`,
            `top:${rect.top}px`,
            `width:${dimWidth}px`,
            `height:${rect.height}px`,
            'background:rgba(235,238,242,0.82)',
            'display:block',
          ].join(';');
        } else {
          dimEl.style.display = 'none';
        }
      }

      // Hide pool elements not needed this frame
      for (let i = ccCells.length; i < overlayPool.length; i++) {
        overlayPool[i].style.display = 'none';
      }
      for (let i = ccCells.length; i < rowDimPool.length; i++) {
        rowDimPool[i].style.display = 'none';
      }
    }

    function scheduleUpdate() {
      if (!biRafPending) { biRafPending = true; requestAnimationFrame(updateBiOverlays); }
    }

    // Initial render
    updateBiOverlays();
    log('BI: Progress % overlay active —', progressByCc.size,
        'CC(s) with tracking data | CC col left=' + ccLeft + 'px | progress col left=' + progressLeft + 'px');

    // ── MutationObserver: fires when ReactVirtualized adds/repositions rows ────
    let biMoTimer = null;
    const biObserver = new MutationObserver(() => {
      // Debounce slightly so bursts of attribute changes collapse into one rAF
      clearTimeout(biMoTimer);
      biMoTimer = setTimeout(scheduleUpdate, 20);
    });
    biObserver.observe(dataContainer, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style'],
    });

    // ── Scroll listener: rAF-based for zero perceived lag ─────────────────────
    dataGrid.addEventListener('scroll', scheduleUpdate, { passive: true });

    // ── Continuous header-position tracker via rAF ─────────────────────────────
    // Metabase's layout can shift when side-panels toggle (not just on resize),
    // so polling with rAF is the only reliable way to keep the header overlay
    // pixel-perfect. We compare top + left and only call positionHdrOverlay()
    // when the values actually change — zero overhead when nothing moves.
    let _phTop = null, _phLeft = null;
    (function trackPosition() {
      const hr = (headerGrid || tableInteractive).getBoundingClientRect();
      const tr = tableInteractive.getBoundingClientRect();
      if (hr.top !== _phTop || tr.left !== _phLeft) {
        _phTop = hr.top;
        _phLeft = tr.left;
        positionHdrOverlay();
        scheduleUpdate();
      }
      requestAnimationFrame(trackPosition);
    })();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. DISPATCHER
  // ═══════════════════════════════════════════════════════════════════════════
  function run() {
    if (window.top !== window.self) return;
    const host = location.hostname;
    const path = location.pathname;

    // BI overlay — different domain (reportbuilder.simprosuite.com)
    if (host.includes('reportbuilder.simprosuite.com')) {
      bootstrapBIPage().catch(e => err('BI bootstrap failed', e));
      return;
    }

    // SimPro cost-centre / job pages
    if (/editCostCentre\.php$/i.test(path)) {
      bootstrapCostCentreEdit().catch(e => { err('bootstrap failed', e); toast('Materials Tracker error: ' + e.message, { error: true }); });
    } else if (/editProject\.php$/i.test(path)) {
      bootstrapJobList().catch(e => { err('jobList failed', e); });
      // The list page is tab-heavy — re-run if the Cost Centre tab is activated later.
      let lastHash = location.hash;
      setInterval(() => {
        if (location.hash !== lastHash) {
          lastHash = location.hash;
          bootstrapJobList().catch(e => err('jobList re-run failed', e));
        }
      }, 1500);
    }
  }
  run();
})();

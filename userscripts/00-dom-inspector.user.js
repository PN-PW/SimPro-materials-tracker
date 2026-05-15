// ==UserScript==
// @name         SimPro Materials Tracker - DOM Inspector
// @namespace    https://powernaturally.simprosuite.com/
// @version      0.1.0
// @description  One-off inspector: prints the structure of the materials allocation table so we can lock in a stable per-row identifier.
// @author       PowerNaturally
// @match        https://powernaturally.simprosuite.com/staff/editCostCentre.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[MT-Inspector]';
  const log = (...a) => console.log(TAG, ...a);
  const group = (label, fn) => { console.groupCollapsed(TAG, label); try { fn(); } finally { console.groupEnd(); } };

  function waitFor(selector, { timeout = 15000, interval = 200 } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - start > timeout) return reject(new Error(`timeout waiting for ${selector}`));
        setTimeout(poll, interval);
      })();
    });
  }

  function summarizeAttrs(el) {
    const out = {};
    for (const a of el.attributes) out[a.name] = a.value;
    return out;
  }

  function snapshotRow(row, index) {
    const inputs = [...row.querySelectorAll('input, select, textarea')].map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.type,
      name: el.name,
      id: el.id,
      value: (el.value || '').slice(0, 80),
    }));
    const dataAttrs = {};
    for (const a of row.attributes) if (a.name.startsWith('data-') || a.name === 'id') dataAttrs[a.name] = a.value;
    const firstCellText = (row.querySelector('td, div')?.innerText || '').trim().slice(0, 120);
    return {
      rowIndex: index,
      tag: row.tagName.toLowerCase(),
      rowAttrs: dataAttrs,
      firstCellText,
      inputCount: inputs.length,
      inputs,
    };
  }

  function findMaterialRows() {
    // Try a few strategies and report what hits.
    const strategies = [
      { name: 'tr with data-id', sel: 'tr[data-id]' },
      { name: 'tr with id starting material', sel: 'tr[id^="material"], tr[id^="row"], tr[id^="stock"]' },
      { name: 'table.materials tr', sel: 'table.materials tbody tr, table[id*="material" i] tbody tr' },
      { name: 'any tbody tr with a number input', sel: 'tbody tr:has(input[type="number"])' },
      { name: 'div rows with data-id', sel: 'div[data-id][class*="row" i]' },
    ];
    const results = [];
    for (const s of strategies) {
      try {
        const nodes = document.querySelectorAll(s.sel);
        results.push({ ...s, count: nodes.length, sample: nodes[0] || null });
      } catch (e) {
        results.push({ ...s, count: 0, error: e.message });
      }
    }
    return results;
  }

  function findUpdateButton() {
    const candidates = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a')]
      .filter(el => /update\s*materials/i.test(el.value || el.innerText || ''));
    return candidates.map(el => ({
      tag: el.tagName.toLowerCase(),
      text: (el.value || el.innerText || '').trim(),
      id: el.id, name: el.name, classes: el.className,
      parentId: el.parentElement?.id, parentClass: el.parentElement?.className,
    }));
  }

  function findUrlIds() {
    const url = new URL(location.href);
    const params = Object.fromEntries(url.searchParams.entries());
    const jobIdFromBreadcrumb = document.body.innerText.match(/Project Job\s*#(\d+)/i)?.[1] ?? null;
    const costCentreIdFromBreadcrumb = document.body.innerText.match(/#(\d{3,})\s*$/m)?.[1] ?? null;
    return { href: location.href, params, jobIdFromBreadcrumb, costCentreIdFromBreadcrumb };
  }

  async function run() {
    log('starting inspection…');

    group('URL & IDs', () => log(JSON.stringify(findUrlIds(), null, 2)));

    group('Row-detection strategies', () => {
      const r = findMaterialRows();
      for (const s of r) {
        log(`${s.name} → ${s.count} matches (selector: ${s.sel})`);
      }
    });

    // Pick the best-hit strategy.
    const best = findMaterialRows().filter(s => s.count > 0).sort((a, b) => b.count - a.count)[0];
    if (!best) {
      log('no rows found with any strategy — you may need to be on the Stock → Allocated tab with materials visible');
      return;
    }
    log('best strategy:', best.name, '→', best.count, 'rows');

    const rows = [...document.querySelectorAll(best.sel)];
    const snapshots = rows.slice(0, 3).map(snapshotRow);
    group('First 3 row snapshots', () => log(JSON.stringify(snapshots, null, 2)));

    group('"Update Materials" button candidates', () => log(JSON.stringify(findUpdateButton(), null, 2)));

    // Also dump the first row's outerHTML (trimmed) for pattern analysis.
    group('First row outerHTML (truncated to 4 KB)', () => {
      const html = rows[0]?.outerHTML || '';
      log(html.length > 4096 ? html.slice(0, 4096) + '\n…[truncated]' : html);
    });

    log('done. Copy this whole console group back to Claude.');
  }

  // The table may render after document-idle; be patient.
  waitFor('body').then(run).catch(err => log('fatal:', err));
})();

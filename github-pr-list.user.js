// ==UserScript==
// @name         GitHub PR list — Show opener avatar on the left, and reviewers instead of assignees on the right
// @namespace    https://github.com/danieleformichelli/tampermonkey-scripts
// @version      1.0.0
// @description  Show opener avatar on the left, and reviewers in place of the assignees.
// @author       Daniele Formichelli
// @match        https://github.com/*/*/pulls*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  // ---- config ---------------------------------------------------------------
  const MAX_AVATARS = 4; // avatars before a "+N" badge
  const CONCURRENCY = 25; // parallel sidebar fetches (one PR-list page)
  const FALLBACK_TO_ASSIGNEES = false; // never show assignees again once reviewers are the point
  let ignoreList = ['cursor', 'copilot'];
  try {
    const saved = GM_getValue('ignoreReviewers', null);
    if (Array.isArray(saved)) ignoreList = saved;
  } catch (err) {
    /* storage unavailable; keep defaults */
  }
  const isIgnored = (name) =>
    ignoreList.some((entry) => name.toLowerCase().includes(String(entry).toLowerCase()));
  const STATUS = {
    approved: { color: 'var(--fgColor-success, #2da44e)', label: 'approved these changes' },
    changes: { color: 'var(--fgColor-danger, #cf222e)', label: 'requested changes' },
    pending: { color: 'var(--fgColor-attention, #d29922)', label: 'review pending' },
    commented: { color: 'var(--fgColor-muted, #8b949e)', label: 'left review comments' },
  };

  // ---- context --------------------------------------------------------------
  const DEBUG = false; // set true to log per-row activity to the console
  const [owner, repo] = location.pathname.split('/').filter(Boolean);
  if (!owner || !repo) return;
  if (DEBUG) console.log('[gh-pr-reviewers] loaded for', owner + '/' + repo);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pullHref = new RegExp(`^/${esc(owner)}/${esc(repo)}/pull/(\\d+)/?$`);

  // hide assignees in flagged rows; a stylesheet survives React replacing the node
  const hideStyle = document.createElement('style');
  hideStyle.textContent = 'li.gh-pr-reviewers-row [class*="alignRight"]{display:none !important}';
  (document.head || document.documentElement).appendChild(hideStyle);

  // ---- fetch reviewers from the same-origin sidebar partial -----------------
  const cache = new Map();
  const inflight = new Map();

  // last session's results, kept so reviewers can paint before the network answers
  const STORE_KEY = `gh-pr-reviewers:${owner}/${repo}`;
  let store = {};
  try {
    store = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
  } catch (err) {
    store = {};
  }
  let saveTimer = null;
  function persist(num, reviewers) {
    store[num] = { reviewers, ts: Date.now() };
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
      } catch (err) {
        /* storage may be full/blocked; cache is best-effort */
      }
    }, 500);
  }
  function cachedReviewers(num) {
    const entry = store[num];
    return entry && Array.isArray(entry.reviewers) ? entry.reviewers : null;
  }

  const partialUrl = (num) =>
    `/${owner}/${repo}/issues/${num}/show_partial?partial=` +
    encodeURIComponent('pull_requests/sidebar/show/reviewers');

  function fetchReviewers(num) {
    if (cache.has(num)) return Promise.resolve(cache.get(num));
    if (inflight.has(num)) return inflight.get(num);

    const p = fetch(location.origin + partialUrl(num), { credentials: 'same-origin', headers: { Accept: 'text/html' } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(parseReviewers)
      .then((list) => {
        cache.set(num, list);
        persist(num, list);
        if (DEBUG) console.log('[gh-pr-reviewers] #' + num, list.length, 'reviewer(s)', list.map((r) => r.name + ':' + r.status));
        return list;
      })
      .catch((err) => {
        console.warn('[gh-pr-reviewers] fetch failed for #' + num, err);
        cache.set(num, null); // don't hammer a failing endpoint on every mutation
        return null;
      })
      .finally(() => inflight.delete(num));

    inflight.set(num, p);
    return p;
  }

  // ---- parse the sidebar partial -------------------------------------------
  function parseReviewers(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    for (const span of doc.querySelectorAll('span.js-hovercard-left[data-assignee-name]')) {
      const block = span.closest('div');
      const tip = block && block.querySelector('tool-tip');
      const text = tip ? tip.textContent.toLowerCase() : '';
      let status = 'pending';
      if (/approved/.test(text)) status = 'approved';
      else if (/requested changes|changes requested/.test(text)) status = 'changes';
      else if (/left review comments|commented/.test(text)) status = 'commented';
      else if (/awaiting|requested review/.test(text)) status = 'pending';

      const img = span.querySelector('img.avatar');
      const link = span.querySelector('a.assignee');
      const name = span.getAttribute('data-assignee-name');
      out.push({
        name,
        avatar: img ? img.getAttribute('src') : null,
        href: link ? link.getAttribute('href') : null,
        status,
      });
    }
    return out;
  }

  // ---- simple concurrency queue --------------------------------------------
  let active = 0;
  const queue = [];
  function schedule(fn) {
    queue.push(fn);
    pump();
  }
  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const fn = queue.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  // ---- DOM helpers ----------------------------------------------------------
  function ensureCell(row, meta) {
    let cell = meta.querySelector(':scope > .gh-pr-reviewers');
    if (!cell) {
      cell = document.createElement('div');
      cell.className = 'gh-pr-reviewers';
      Object.assign(cell.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: '4px',
        marginLeft: 'auto',
      });
      meta.appendChild(cell);
    }
    return cell;
  }

  const initial = (name) => (name && name.trim()[0] ? name.trim()[0].toUpperCase() : '?');

  function authorLogin(row) {
    const link = row.querySelector('[data-testid="author-filter-link"]');
    if (!link) return null;
    try {
      // href is "...?q=is%3Apr+...author%3A<login>"; the aria-label may carry a display name
      const q = decodeURIComponent(link.getAttribute('href') || '');
      const m = /author:([^&\s]+)/.exec(q);
      return m ? m[1] : null;
    } catch (err) {
      return null;
    }
  }

  function addOpener(row) {
    const title = row.querySelector('[data-listview-item-title-container]');
    if (!title || title.querySelector(':scope > .gh-pr-opener')) return;
    const login = authorLogin(row);
    if (!login) return;

    const a = document.createElement('a');
    a.className = 'gh-pr-opener';
    a.href = `/${login}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = `Opened by ${login}`;
    Object.assign(a.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: 'middle',
      marginRight: '8px',
    });

    const img = document.createElement('img');
    img.src = `https://github.com/${encodeURIComponent(login)}.png?size=48`;
    img.alt = login;
    img.width = 20;
    img.height = 20;
    Object.assign(img.style, {
      borderRadius: '50%',
      display: 'block',
      background: 'var(--bgColor-muted, #30363d)',
    });
    img.addEventListener(
      'error',
      () => {
        img.remove();
        a.textContent = initial(login);
        Object.assign(a.style, {
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          fontSize: '11px',
          fontWeight: '600',
          color: '#fff',
          background: 'var(--fgColor-muted, #8b949e)',
        });
      },
      { once: true },
    );
    a.appendChild(img);

    const heading = title.querySelector('h3');
    title.insertBefore(a, heading || title.firstChild);
  }

  function avatarNode(r) {
    const s = STATUS[r.status] || STATUS.pending;
    const a = document.createElement('a');
    a.href = r.href || '#';
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = `${r.name} - ${s.label}`;
    Object.assign(a.style, { display: 'inline-flex', alignItems: 'center' });

    if (r.avatar) {
      const img = document.createElement('img');
      img.src = r.avatar;
      img.alt = r.name;
      img.width = 20;
      img.height = 20;
      Object.assign(img.style, {
        borderRadius: '50%',
        boxShadow: `0 0 0 2px ${s.color}`,
        background: 'var(--bgColor-default, #fff)',
        display: 'block',
      });
      a.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.textContent = initial(r.name);
      Object.assign(span.style, {
        width: '20px',
        height: '20px',
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '11px',
        fontWeight: '600',
        color: '#fff',
        background: s.color,
      });
      a.appendChild(span);
    }
    return a;
  }

  function renderCell(cell, reviewers) {
    cell.textContent = '';
    for (const r of reviewers.slice(0, MAX_AVATARS)) cell.appendChild(avatarNode(r));
    const hidden = reviewers.length - MAX_AVATARS;
    if (hidden > 0) {
      const more = document.createElement('span');
      more.textContent = `+${hidden}`;
      more.title = reviewers
        .slice(MAX_AVATARS)
        .map((r) => r.name)
        .join(', ');
      Object.assign(more.style, { fontSize: '11px', color: 'var(--fgColor-muted, #8b949e)' });
      cell.appendChild(more);
    }
  }

  function apply(row, reviewers) {
    const meta = row.querySelector('[class*="MetadataContainer"]');
    if (!meta) {
      if (DEBUG) console.warn('[gh-pr-reviewers] no MetadataContainer in row, skipping');
      return;
    }

    const cell = ensureCell(row, meta);
    const visible = (reviewers || []).filter((r) => !isIgnored(r.name));
    const has = visible.length > 0;
    // order-independent, so a reshuffled sidebar doesn't force a repaint
    const sig = has
      ? visible
          .map((r) => r.name + ':' + r.status)
          .sort()
          .join('|')
      : '';
    if (cell.dataset.ghSig === sig && cell.dataset.ghDone === '1') return;
    cell.dataset.ghSig = sig;
    cell.dataset.ghDone = '1';

    row.classList.toggle('gh-pr-reviewers-row', has || !FALLBACK_TO_ASSIGNEES);
    cell.textContent = '';
    cell.style.display = has || !FALLBACK_TO_ASSIGNEES ? 'flex' : 'none';
    if (has) renderCell(cell, visible);
  }

  // ---- main loop ------------------------------------------------------------
  function collectRows() {
    const rows = new Map(); // num -> <li>
    for (const a of document.querySelectorAll('a[href]')) {
      let pathname;
      try {
        pathname = new URL(a.href, location.href).pathname;
      } catch (err) {
        continue;
      }
      const m = pullHref.exec(pathname);
      if (!m) continue;
      const li = a.closest('li');
      if (li && !rows.has(m[1])) rows.set(m[1], li);
    }
    return rows;
  }

  function run() {
    const rows = collectRows();
    if (DEBUG) console.log('[gh-pr-reviewers] run: matched', rows.size, 'PR row(s)', [...rows.keys()]);
    if (rows.size === 0 && DEBUG) {
      console.warn(
        '[gh-pr-reviewers] no rows matched. Sample pull hrefs:',
        [...document.querySelectorAll('a[href*="/pull/"]')].slice(0, 3).map((a) => a.getAttribute('href')),
      );
    }
    for (const [num, row] of rows) {
      // flag the row (CSS hides its assignees instantly), then fill reviewers
      const meta = row.querySelector('[class*="MetadataContainer"]');
      if (!meta) continue;
      row.classList.add('gh-pr-reviewers-row');
      ensureCell(row, meta);
      addOpener(row);

      const cached = cachedReviewers(num);
      if (cached) apply(row, cached); // paint last session's result instantly, refresh below

      schedule(() =>
        fetchReviewers(num).then((reviewers) => {
          if (reviewers !== null && row.isConnected) apply(row, reviewers);
        }),
      );
    }
  }

  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      run();
    }, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Configure hidden reviewers', () => {
      const input = prompt(
        'Reviewers to hide (comma-separated, case-insensitive):',
        ignoreList.join(', '),
      );
      if (input === null) return;
      ignoreList = input
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        GM_setValue('ignoreReviewers', ignoreList);
      } catch (err) {
        /* storage unavailable */
      }
      // force a repaint with the new filter
      document.querySelectorAll('.gh-pr-reviewers').forEach((cell) => {
        delete cell.dataset.ghSig;
        delete cell.dataset.ghDone;
      });
      run();
    });
  }

  run();
})();

// ==UserScript==
// @name         GitHub PR list — Show opener avatar on the left, and reviewers instead of assignees on the right
// @namespace    https://github.com/danieleformichelli
// @version      1.0.1
// @description  Show opener avatar on the left, and reviewers in place of the assignees.
// @author       Daniele Formichelli
// @match        https://github.com/*/*/pulls*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---- config ---------------------------------------------------------------
  const MAX_AVATARS = 4; // avatars before a "+N" badge
  const AVATAR_SIZE = 20; // px
  const AVATAR_GAP = 8; // px between reviewer avatars; the 2px status ring eats into it on both sides
  const MORE_WIDTH = 24; // px reserved for the "+N" badge
  // fixed so every row's cell is the same width and the metadata columns line up across rows
  const CELL_WIDTH = MAX_AVATARS * AVATAR_SIZE + MAX_AVATARS * AVATAR_GAP + MORE_WIDTH;
  const CONCURRENCY = 25; // parallel sidebar fetches (one PR-list page)
  const FALLBACK_TO_ASSIGNEES = false; // never show assignees again once reviewers are the point
  const IGNORE_REVIEWERS = [/cursor/i, /copilot/i, /tractive-guardian/i]; // reviewer logins/teams to drop
  // `icon` is an official Primer Octicon path (MIT), drawn as a badge on the avatar's corner for
  // states the ring colour alone doesn't tell apart (both are muted grey)
  const STATUS = {
    approved: { color: 'var(--fgColor-success, #2da44e)', label: 'approved these changes' },
    changes: { color: 'var(--fgColor-danger, #cf222e)', label: 'requested changes' },
    pending: { color: 'var(--fgColor-attention, #d29922)', label: 'review pending' },
    commented: {
      color: 'var(--fgColor-muted, #8b949e)',
      label: 'left review comments',
      // octicon comment-16
      icon: 'M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z',
    },
    dismissed: {
      color: 'var(--fgColor-muted, #8b949e)',
      label: 'review dismissed',
      // octicon x-16
      icon: 'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z',
    },
  };
  const BADGE_SIZE = 13; // px, status octicon badge on the avatar's bottom-right corner

  // ---- context --------------------------------------------------------------
  const DEBUG = false; // set true to log per-row activity to the console
  const [owner, repo] = location.pathname.split('/').filter(Boolean);
  if (!owner || !repo) return;
  window.__ghPrReviewers = { version: '1.0.1', owner, repo, loadedAt: Date.now() };
  if (DEBUG) console.log('[gh-pr-reviewers] loaded for', owner + '/' + repo);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pullHref = new RegExp(`^/${esc(owner)}/${esc(repo)}/pull/(\\d+)/?$`);

  // a stylesheet survives React replacing nodes or resetting the row's className.
  // - assignees are an alignRight item (comfortable) or a fixed-width metadataAssignees column
  //   (compact): hide them next to our cell, the opener avatar already says who owns the PR
  // - switching layouts makes React append the new layout's metadata after our cell, so `order`
  //   keeps the cell last without moving the node
  // - compact view lays the cell out on a single line, so it centers; comfortable view spans
  //   title + description, so pin the cell to the title line (offset measured in alignToTitle)
  const hideStyle = document.createElement('style');
  hideStyle.textContent = `
    li.gh-pr-reviewers-row [class*="alignRight"],
    li.gh-pr-reviewers-row [class*="metadataAssignees"],
    [class*="MetadataContainer"]:has(> .gh-pr-reviewers) > [class*="alignRight"],
    [class*="MetadataContainer"]:has(> .gh-pr-reviewers) > [class*="metadataAssignees"] { display: none !important; }
    li > .gh-pr-opener { display: none !important; }
    .gh-pr-reviewers { align-self: center; order: 9999; }
    li:not([class*="listItemCompact"]) .gh-pr-reviewers {
      align-self: flex-start;
      margin-top: var(--gh-pr-reviewers-offset, 10px);
    }
  `;
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

    const p = fetch(partialUrl(num), { credentials: 'same-origin', headers: { Accept: 'text/html' } })
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
      // dismissed first: a dismissed approval's tooltip may still mention "approved"
      if (/dismissed/.test(text)) status = 'dismissed';
      else if (/approved/.test(text)) status = 'approved';
      else if (/requested changes|changes requested/.test(text)) status = 'changes';
      else if (/left review comments|commented/.test(text)) status = 'commented';
      else if (/awaiting|requested review/.test(text)) status = 'pending';

      const img = span.querySelector('img.avatar');
      const link = span.querySelector('a.assignee');
      const name = span.getAttribute('data-assignee-name');
      if (IGNORE_REVIEWERS.some((re) => re.test(name))) continue;
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
        justifyContent: 'flex-start',
        gap: `${AVATAR_GAP}px`,
        width: `${CELL_WIDTH}px`,
        flexShrink: '0',
        height: `${AVATAR_SIZE}px`,
        paddingLeft: '2px', // keep the first avatar's ring from being clipped
        boxSizing: 'content-box',
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
      // href is "...?q=is%3Apr+...author%3A<login>"
      const q = decodeURIComponent(link.getAttribute('href') || '');
      const m = /author:([^&\s]+)/.exec(q);
      if (m) return m[1];
    } catch (err) {
      // fall through to the label
    }
    // GitHub may render a <button> without href; its label is "Filter by author <Name (login)|login>"
    const label = (link.getAttribute('aria-label') || '').replace(/^Filter by author\s+/, '').trim();
    const paren = /\(([\w-]+(?:\[bot\])?)\)$/.exec(label);
    if (paren) return paren[1];
    return /^[\w-]+(?:\[bot\])?$/.test(label) ? label : null;
  }

  function addOpener(row) {
    const title = row.querySelector('[data-listview-item-title-container]');
    if (!title) return;
    // inside the <h3> so it flows with the title text in both compact and comfortable layouts
    const heading = title.querySelector('h3');
    const host = heading || title;
    // drop openers left elsewhere in the row (e.g. after React re-rendered around them)
    for (const stray of row.querySelectorAll('.gh-pr-opener')) {
      if (stray.parentElement !== host) stray.remove();
    }
    if (host.querySelector(':scope > .gh-pr-opener')) return;
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

    host.insertBefore(a, host.firstChild);
  }

  // comfortable rows: line the reviewers cell up with the opener on the title line.
  // Every row shares the same geometry, so one measurement drives a CSS variable for all.
  let titleOffset = null;
  function alignToTitle(rows) {
    for (const row of rows) {
      if (/listItemCompact/.test(row.className)) continue;
      const opener = row.querySelector('.gh-pr-opener');
      const meta = row.querySelector('[class*="MetadataContainer"]');
      if (!opener || !meta) continue;
      const o = opener.getBoundingClientRect();
      const m = meta.getBoundingClientRect();
      if (!o.height || !m.height) continue;
      const offset = Math.round(o.top - m.top);
      if (offset !== titleOffset) {
        titleOffset = offset;
        document.documentElement.style.setProperty('--gh-pr-reviewers-offset', `${offset}px`);
      }
      return;
    }
  }

  function avatarNode(r) {
    const s = STATUS[r.status] || STATUS.pending;
    const a = document.createElement('a');
    a.href = r.href || '#';
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = `${r.name} - ${s.label}`;
    Object.assign(a.style, {
      position: 'relative', // anchors the status badge
      display: 'inline-flex',
      alignItems: 'center',
      flexShrink: '0',
      width: `${AVATAR_SIZE}px`,
      height: `${AVATAR_SIZE}px`,
      lineHeight: '0',
    });

    if (r.avatar) {
      const img = document.createElement('img');
      img.src = r.avatar;
      img.alt = r.name;
      img.width = AVATAR_SIZE;
      img.height = AVATAR_SIZE;
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
        width: `${AVATAR_SIZE}px`,
        height: `${AVATAR_SIZE}px`,
        lineHeight: 'normal',
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
    if (s.icon) a.appendChild(statusBadge(s.icon));
    return a;
  }

  function statusBadge(d) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [key, value] of Object.entries({
      viewBox: '0 0 16 16',
      width: String(BADGE_SIZE),
      height: String(BADGE_SIZE),
      fill: 'currentColor',
      'aria-hidden': 'true',
      focusable: 'false',
    })) {
      svg.setAttribute(key, value);
    }
    Object.assign(svg.style, {
      position: 'absolute',
      right: '-4px',
      bottom: '-4px',
      boxSizing: 'border-box',
      padding: '1px',
      borderRadius: '50%',
      background: 'var(--bgColor-default, #fff)',
      border: '1px solid var(--borderColor-default, #d0d7de)',
      color: 'var(--fgColor-muted, #8b949e)',
      pointerEvents: 'none',
    });
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  function renderCell(cell, reviewers) {
    cell.textContent = '';
    // dismissed reviews matter least, so they're the first to fall into the "+N" overflow;
    // sort is stable, so everyone else keeps the sidebar's order
    reviewers = [...reviewers].sort((a, b) => (a.status === 'dismissed') - (b.status === 'dismissed'));
    for (const r of reviewers.slice(0, MAX_AVATARS)) cell.appendChild(avatarNode(r));
    const hidden = reviewers.length - MAX_AVATARS;
    if (hidden > 0) {
      const more = document.createElement('span');
      more.textContent = `+${hidden}`;
      more.title = reviewers
        .slice(MAX_AVATARS)
        .map((r) => r.name)
        .join(', ');
      Object.assign(more.style, { fontSize: '11px', lineHeight: `${AVATAR_SIZE}px`, color: 'var(--fgColor-muted, #8b949e)' });
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
    const has = reviewers && reviewers.length > 0;
    // order-independent, so a reshuffled sidebar doesn't force a repaint
    const sig = has
      ? reviewers
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
    if (has) renderCell(cell, reviewers);
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
    alignToTitle(rows.values());
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

  run();
})();

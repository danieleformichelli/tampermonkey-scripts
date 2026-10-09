// ==UserScript==
// @name         GitHub PR list — Show opener avatar on the left, and reviewers instead of assignees on the right
// @namespace    https://github.com/danieleformichelli
// @version      1.0.1
// @description  Show opener avatar on the left, and reviewers in place of the assignees.
// @author       Daniele Formichelli
// @match        https://github.com/*
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
  // machine users: regular accounts run by automation, which nothing in the markup tells apart from
  // people (app bots are detected by isBot). Exact logins, case-insensitive.
  const BOT_LOGINS = ['tractive-guardian'];
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
  // GitHub navigates in-page (e.g. commits/branches -> Pull requests), so the script runs on every
  // page and re-reads the repo from the URL on each pass; it only acts on a repo's PR list.
  const PULLS_PATH = /^\/([^/]+)\/([^/]+)\/pulls(?:\/|$)/;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let owner = null;
  let repo = null;
  let pullHref = null;

  // returns false when the current page isn't a repo PR list
  function syncRepo() {
    const m = PULLS_PATH.exec(location.pathname);
    if (!m) return false;
    if (m[1] === owner && m[2] === repo) return true;
    owner = m[1];
    repo = m[2];
    pullHref = new RegExp(`^/${esc(owner)}/${esc(repo)}/pull/(\\d+)/?$`);
    loadStore();
    window.__ghPrReviewers = { version: '1.0.1', owner, repo, loadedAt: Date.now() };
    if (DEBUG) console.log('[gh-pr-reviewers] now on', owner + '/' + repo);
    return true;
  }

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
    /* comfortable view already shows the author's avatar next to their name under the title */
    li:not([class*="listItemCompact"]) .gh-pr-opener { display: none !important; }
    .gh-pr-reviewers { align-self: center; order: 9999; }
    li:not([class*="listItemCompact"]) .gh-pr-reviewers {
      align-self: flex-start;
      margin-top: var(--gh-pr-reviewers-offset, 10px);
    }

    /* "Pending reviews by" bar; a data attribute (not a class) hides rows, React resets className */
    li[data-gh-pr-filtered] { display: none !important; }
    .gh-pr-pending-bar {
      display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
      padding: 6px 16px; line-height: 20px;
      border-bottom: 1px solid var(--borderColor-muted, #d0d7de);
    }
    .gh-pr-pending-bar[hidden] { display: none; }
    .gh-pr-pending-label { font-size: 14px; color: var(--fgColor-muted, #656d76); white-space: nowrap; margin-right: 4px; }
    .gh-pr-pending-btn {
      position: relative; width: 28px; height: 28px; padding: 0;
      border: 0; border-radius: 50%; background: var(--bgColor-muted, #f6f8fa);
      cursor: pointer; transition: transform 0.15s, box-shadow 0.15s;
    }
    .gh-pr-pending-btn:hover { transform: scale(1.1); }
    .gh-pr-pending-btn[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--fgColor-accent, #0969da); }
    .gh-pr-pending-btn img { width: 100%; height: 100%; display: block; border-radius: 50%; }
    .gh-pr-pending-initial {
      display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;
      font-size: 12px; font-weight: 600; color: var(--fgColor-muted, #656d76);
    }
    .gh-pr-pending-count {
      position: absolute; top: -3px; right: -3px;
      display: flex; align-items: center; justify-content: center; box-sizing: border-box;
      min-width: 14px; height: 14px; padding: 0 3px; border-radius: 999px;
      border: 1px solid var(--bgColor-default, #fff);
      background: var(--bgColor-neutral-emphasis, #6e7781); color: var(--fgColor-onEmphasis, #fff);
      font-size: 10px; font-weight: 600; line-height: 1; pointer-events: none;
    }
  `;
  // attached by onUrlChange on the first visit to a PR list

  // ---- fetch reviewers from the same-origin sidebar partial -----------------
  // keyed "owner/repo#num": in-page navigation can switch repos while fetches are in flight.
  // Cleared on every URL change, so returning to the list refetches instead of showing stale data.
  const cache = new Map();
  const inflight = new Map();
  const cacheKey = (num) => `${owner}/${repo}#${num}`;

  // last session's results, kept so reviewers can paint before the network answers
  let storeKey = null;
  let store = {};
  const saveTimers = new Map(); // storeKey -> timer
  function loadStore() {
    storeKey = `gh-pr-reviewers:${owner}/${repo}`;
    try {
      store = JSON.parse(localStorage.getItem(storeKey) || '{}') || {};
    } catch (err) {
      store = {};
    }
  }
  // takes the repo's key and store explicitly: the fetch may finish after navigating to another repo
  function persist(key, target, num, reviewers) {
    target[num] = { reviewers, ts: Date.now() };
    if (saveTimers.has(key)) return;
    saveTimers.set(
      key,
      setTimeout(() => {
        saveTimers.delete(key);
        try {
          localStorage.setItem(key, JSON.stringify(target));
        } catch (err) {
          /* storage may be full/blocked; cache is best-effort */
        }
      }, 500),
    );
  }
  function cachedReviewers(num) {
    const entry = store[num];
    return entry && Array.isArray(entry.reviewers) ? entry.reviewers : null;
  }

  const partialUrl = (num) =>
    `/${owner}/${repo}/issues/${num}/show_partial?partial=` +
    encodeURIComponent('pull_requests/sidebar/show/reviewers');

  function fetchReviewers(num) {
    const key = cacheKey(num);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);
    const repoStoreKey = storeKey;
    const repoStore = store;

    const p = fetch(partialUrl(num), { credentials: 'same-origin', headers: { Accept: 'text/html' } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(parseReviewers)
      .then((list) => {
        cache.set(key, list);
        persist(repoStoreKey, repoStore, num, list);
        if (DEBUG) console.log('[gh-pr-reviewers] ' + key, list.length, 'reviewer(s)', list.map((r) => r.name + ':' + r.status));
        return list;
      })
      .catch((err) => {
        console.warn('[gh-pr-reviewers] fetch failed for ' + key, err);
        cache.set(key, null); // don't hammer a failing endpoint on every mutation
        return null;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
  }

  // ---- parse the sidebar partial -------------------------------------------
  // GitHub marks app accounts structurally, so no guessing from the login: people link to /<login>
  // with hovercard type "user", teams to /orgs/... with "team"; apps (Copilot, Cursor, Renovate, ...)
  // link to /apps/<slug> and carry their own hovercard type, e.g. "copilot" or "bot".
  // Machine users look like people, so they come from BOT_LOGINS.
  const botLogins = new Set(BOT_LOGINS.map((l) => l.toLowerCase()));
  function isBot(span, link, name) {
    const href = link ? link.getAttribute('href') || '' : '';
    const type = span.getAttribute('data-hovercard-type') || '';
    return (
      href.startsWith('/apps/') ||
      type === 'bot' ||
      type === 'copilot' ||
      /\[bot\]$/i.test(name) ||
      botLogins.has(name.toLowerCase())
    );
  }

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
      if (isBot(span, link, name)) continue;
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

  // comfortable rows: centre the reviewers cell on the title's first line (the opener is hidden
  // there, so the title text is the reference). Every row shares the same geometry, so one
  // measurement drives a CSS variable for all.
  let titleOffset = null;
  function alignToTitle(rows) {
    for (const row of rows) {
      if (/listItemCompact/.test(row.className)) continue;
      const title = row.querySelector('[data-listview-item-title-container] h3');
      const meta = row.querySelector('[class*="MetadataContainer"]');
      if (!title || !meta) continue;
      const line = title.getClientRects()[0]; // first line only, long titles wrap
      const m = meta.getBoundingClientRect();
      if (!line || !line.height || !m.height) continue;
      const offset = Math.round(line.top + line.height / 2 - AVATAR_SIZE / 2 - m.top);
      if (offset !== titleOffset) {
        titleOffset = offset;
        document.documentElement.style.setProperty('--gh-pr-reviewers-offset', `${offset}px`);
      }
      return;
    }
  }

  // clicking a reviewer searches this repo's open PRs: still waiting on them if their review is
  // pending, otherwise the ones they reviewed. Teams can only be requested, never review.
  function reviewerSearch(r) {
    const team = /^\/orgs\/([^/]+)\/teams\/([^/]+)/.exec(r.href || '');
    let filter;
    let what;
    if (team) {
      filter = `team-review-requested:${team[1]}/${team[2]}`;
      what = 'open PRs requesting review from this team';
    } else if (r.status === 'pending') {
      filter = `review-requested:${r.name}`;
      what = `open PRs waiting on ${r.name}'s review`;
    } else {
      filter = `reviewed-by:${r.name}`;
      what = `open PRs reviewed by ${r.name}`;
    }
    const url = new URL(`/${owner}/${repo}/pulls`, location.origin);
    url.searchParams.set('q', `is:pr is:open sort:updated-desc ${filter}`);
    return { href: url.href, what };
  }

  function avatarNode(r) {
    const s = STATUS[r.status] || STATUS.pending;
    const search = reviewerSearch(r);
    const a = document.createElement('a');
    a.href = search.href;
    a.title = `${r.name} - ${s.label}\nClick to show ${search.what}`;
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

  // ---- "Pending reviews by" filter bar ---------------------------------------
  // A reviewer is pending until they approve or request changes, so commented and dismissed
  // reviews still count. The filter only hides rows on the current page.
  const isPending = (r) => r.status !== 'approved' && r.status !== 'changes';
  let activeFilter = null; // reviewer name
  let bar = null;
  let barSig = null;

  const reviewersOf = (num) => cache.get(cacheKey(num)) || cachedReviewers(num) || [];

  function ensureBar() {
    if (bar && bar.isConnected) return bar;
    const list = document.querySelector('ul[data-listview-component="items-list"]');
    if (!list || !list.parentNode) return null;
    bar = document.createElement('div');
    bar.className = 'gh-pr-pending-bar';
    bar.hidden = true;
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-reviewer]');
      if (!btn) return;
      activeFilter = activeFilter === btn.dataset.reviewer ? null : btn.dataset.reviewer;
      updatePending();
    });
    // a sibling of the React-managed <ul>, not a child, so React never removes it
    list.parentNode.insertBefore(bar, list);
    barSig = null;
    return bar;
  }

  function pendingButton(r, count) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gh-pr-pending-btn';
    btn.dataset.reviewer = r.name;
    btn.title = `${r.name}: ${count} pending`;
    btn.setAttribute('aria-label', `Show only pull requests pending review by ${r.name} (${count})`);
    btn.setAttribute('aria-pressed', String(activeFilter === r.name));
    if (r.avatar) {
      const img = document.createElement('img');
      img.src = r.avatar;
      img.alt = '';
      btn.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.className = 'gh-pr-pending-initial';
      span.textContent = initial(r.name);
      btn.appendChild(span);
    }
    const badge = document.createElement('span');
    badge.className = 'gh-pr-pending-count';
    badge.textContent = count > 99 ? '99+' : String(count);
    btn.appendChild(badge);
    return btn;
  }

  function updatePending() {
    if (!syncRepo()) return; // navigated away before the timer fired
    const rows = collectRows();
    const counts = new Map(); // name -> { reviewer, count }
    for (const num of rows.keys()) {
      for (const r of reviewersOf(num)) {
        if (!isPending(r)) continue;
        const entry = counts.get(r.name) || { reviewer: r, count: 0 };
        entry.count++;
        counts.set(r.name, entry);
      }
    }
    // a filter whose reviewer has nothing pending here any more would hide every row with no button to undo it
    if (activeFilter && !counts.has(activeFilter)) activeFilter = null;

    for (const [num, row] of rows) {
      const hide = activeFilter !== null && !reviewersOf(num).some((r) => r.name === activeFilter && isPending(r));
      if (hide) row.setAttribute('data-gh-pr-filtered', '');
      else row.removeAttribute('data-gh-pr-filtered');
    }

    const el = ensureBar();
    if (!el) return;
    const entries = [...counts.values()].sort((a, b) =>
      a.reviewer.name.localeCompare(b.reviewer.name, undefined, { sensitivity: 'base' }),
    );
    // our own DOM writes wake the MutationObserver, so only repaint when something changed
    const sig = activeFilter + '|' + entries.map((e) => `${e.reviewer.name}:${e.count}`).join(',');
    if (sig === barSig) return;
    barSig = sig;

    const label = document.createElement('span');
    label.className = 'gh-pr-pending-label';
    label.textContent = 'Pending reviews by:';
    el.replaceChildren(label, ...entries.map((e) => pendingButton(e.reviewer, e.count)));
    el.hidden = entries.length === 0;
  }

  let pendingTimer = null;
  function schedulePending() {
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      updatePending();
    }, 100);
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

  let lastHref = null;
  function run() {
    if (!syncRepo()) {
      if (bar && bar.isConnected) bar.remove(); // in case GitHub kept the container on leaving the list
      lastHref = null;
      return;
    }
    if (location.href !== lastHref) {
      // a new list (or the same one revisited): refetch so reviewers aren't stale; the stored
      // copy still paints instantly while the fetches run. The bar's filter is per page, so reset it.
      lastHref = location.href;
      cache.clear();
      activeFilter = null;
    }
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
          schedulePending();
        }),
      );
    }
    alignToTitle(rows.values());
    schedulePending();
  }

  // ---- lifecycle ------------------------------------------------------------
  // Off the PR list the script only listens for URL changes: no DOM observer, no stylesheet.
  // The observer is attached on entering a PR list and disconnected on leaving it.
  let pending = false;
  function queueRun() {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      run();
    }, 300);
  }

  let observer = null;
  let lastUrl = null;
  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (PULLS_PATH.test(location.pathname)) {
      if (!hideStyle.isConnected) (document.head || document.documentElement).appendChild(hideStyle);
      if (!observer) {
        observer = new MutationObserver(queueRun);
        observer.observe(document.body, { childList: true, subtree: true });
      }
      queueRun(); // the list may already be rendered, or render without further mutations
    } else if (observer) {
      observer.disconnect();
      observer = null;
      run(); // tidies up: removes the bar, forgets the last list URL
    }
  }

  // GitHub navigates with history.pushState, which fires no event of its own. The Navigation API
  // reports it; where that's missing, fall back to a cheap once-a-second URL comparison.
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('currententrychange', onUrlChange);
  } else {
    setInterval(onUrlChange, 1000);
  }
  window.addEventListener('popstate', onUrlChange);
  document.addEventListener('turbo:load', onUrlChange);

  onUrlChange();
})();

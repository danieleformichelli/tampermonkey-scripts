// ==UserScript==
// @name         GitHub PR list — Show opener avatar on the left, and reviewers instead of assignees on the right
// @namespace    https://github.com/danieleformichelli/tampermonkey-scripts
// @version      1.0.1
// @description  Show opener avatar on the left, and reviewers in place of the assignees.
// @author       Daniele Formichelli
// @match        https://github.com/*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  "use strict";

  // ---- config ---------------------------------------------------------------
  const MAX_AVATARS = 5; // avatars before a "+N" badge
  const AVATAR_SIZE = 20; // px
  const AVATAR_GAP = 8; // px between reviewer avatars; the 2px status ring eats into it on both sides
  // compact view: fixed so every row's cell is the same width and the metadata columns line up
  // across rows (comfortable view sizes it to its avatars); the "+N" overflow takes the last
  // avatar slot, so no extra room is reserved for it
  const CELL_WIDTH = MAX_AVATARS * AVATAR_SIZE + (MAX_AVATARS - 1) * AVATAR_GAP;
  const CONCURRENCY = 25; // parallel sidebar fetches (one PR-list page)
  const FALLBACK_TO_ASSIGNEES = false; // never show assignees again once reviewers are the point
  // reviewers to hide on top of the app bots isBot drops, e.g. machine users (regular accounts run
  // by automation, which nothing in the markup tells apart from people). Configurable from the
  // Tampermonkey menu; entries match case-insensitively anywhere in the login.
  let ignoreList = ["cursor", "copilot"];
  try {
    const saved = GM_getValue("ignoreReviewers", null);
    if (Array.isArray(saved)) ignoreList = saved;
  } catch (err) {
    /* storage unavailable; keep defaults */
  }
  const isIgnored = (name) => ignoreList.some((entry) => name.toLowerCase().includes(String(entry).toLowerCase()));
  // applied when rendering, not when parsing, so a menu change takes effect without refetching
  const visibleReviewers = (list) => (list || []).filter((r) => !isIgnored(r.name));
  // `icon` is an official Primer Octicon path (MIT), drawn as a badge on the avatar's corner for
  // states the ring colour alone doesn't tell apart (both are muted grey)
  const STATUS = {
    approved: { color: "var(--fgColor-success, #2da44e)", label: "approved these changes" },
    changes: { color: "var(--fgColor-danger, #cf222e)", label: "requested changes" },
    pending: { color: "var(--fgColor-attention, #d29922)", label: "review pending" },
    commented: {
      color: "var(--fgColor-muted, #8b949e)",
      label: "left review comments",
      // octicon comment-16
      icon: "M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z",
    },
    dismissed: {
      color: "var(--fgColor-muted, #8b949e)",
      label: "review dismissed",
      // octicon x-16
      icon: "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z",
    },
  };
  const BADGE_SIZE = 13; // px, status octicon badge on the avatar's bottom-right corner

  // ---- context --------------------------------------------------------------
  const DEBUG = false; // set true to log per-row activity to the console
  // GitHub navigates in-page (e.g. commits/branches -> Pull requests), so the script runs on every
  // page and re-reads the repo from the URL on each pass; it only acts on a repo's PR list.
  const PULLS_PATH = /^\/([^/]+)\/([^/]+)\/pulls(?:\/|$)/;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    if (DEBUG) console.log("[gh-pr-reviewers] now on", owner + "/" + repo);
    return true;
  }

  // a stylesheet survives React replacing nodes or resetting the row's className, and applies
  // from the first paint (the script runs at document-start), before any row is processed.
  // - assignees are an alignRight item (comfortable) or a fixed-width metadataAssignees column
  //   (compact): hide them, the opener avatar already says who owns the PR. Unscoped unless
  //   FALLBACK_TO_ASSIGNEES, so they never flash in while the script catches up
  // - compact view gives the cell a fixed width so its columns line up across rows; until a row
  //   gets its cell, an empty placeholder of that size holds its place, so the columns don't jump.
  //   Comfortable view has no columns, so the cell just fits its avatars, right-aligned
  // - switching layouts makes React append the new layout's metadata after our cell, so `order`
  //   keeps the cell last without moving the node
  // - the cell centres vertically like GitHub's own metadata items, so it lines up with the
  //   comment count in both layouts
  const assigneeScope = FALLBACK_TO_ASSIGNEES ? "li.gh-pr-reviewers-row " : "";
  const hideStyle = document.createElement("style");
  hideStyle.textContent = `
    ${assigneeScope}[class*="MetadataContainer"] > [class*="alignRight"],
    ${assigneeScope}[class*="MetadataContainer"] > [class*="metadataAssignees"] { display: none !important; }
    li[class*="listItemCompact"] [class*="MetadataContainer"]:not(:has(> .gh-pr-reviewers))::after {
      content: ""; flex: 0 0 ${CELL_WIDTH + 4}px; height: ${AVATAR_SIZE}px;
      align-self: center; order: 9999; margin-left: -16px;
    }
    li > .gh-pr-opener { display: none !important; }
    .gh-pr-reviewers { align-self: center; order: 9999; }
    /* compact cells are a fixed 72px with centred content, so the comment count before us leaves
       ~20px empty on its right; pull the reviewers into it (the 8px column gap still separates them) */
    li[class*="listItemCompact"] .gh-pr-reviewers { width: ${CELL_WIDTH}px; margin-left: -16px !important; }

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
      store = JSON.parse(localStorage.getItem(storeKey) || "{}") || {};
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
    `/${owner}/${repo}/issues/${num}/show_partial?partial=` + encodeURIComponent("pull_requests/sidebar/show/reviewers");

  function fetchReviewers(num) {
    const key = cacheKey(num);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);
    const repoStoreKey = storeKey;
    const repoStore = store;

    const p = fetch(location.origin + partialUrl(num), { credentials: "same-origin", headers: { Accept: "text/html" } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(parseReviewers)
      .then((list) => {
        cache.set(key, list);
        persist(repoStoreKey, repoStore, num, list);
        if (DEBUG)
          console.log(
            "[gh-pr-reviewers] " + key,
            list.length,
            "reviewer(s)",
            list.map((r) => r.name + ":" + r.status),
          );
        return list;
      })
      .catch((err) => {
        console.warn("[gh-pr-reviewers] fetch failed for " + key, err);
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
  // Machine users look like people, so they go in the ignore list.
  function isBot(span, link, name) {
    const href = link ? link.getAttribute("href") || "" : "";
    const type = span.getAttribute("data-hovercard-type") || "";
    return href.startsWith("/apps/") || type === "bot" || type === "copilot" || /\[bot\]$/i.test(name);
  }

  function parseReviewers(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    for (const span of doc.querySelectorAll("span.js-hovercard-left[data-assignee-name]")) {
      const block = span.closest("div");
      const tip = block && block.querySelector("tool-tip");
      const text = tip ? tip.textContent.toLowerCase() : "";
      let status = "pending";
      // dismissed first: a dismissed approval's tooltip may still mention "approved"
      if (/dismissed/.test(text)) status = "dismissed";
      else if (/approved/.test(text)) status = "approved";
      else if (/requested changes|changes requested/.test(text)) status = "changes";
      else if (/left review comments|commented/.test(text)) status = "commented";
      else if (/awaiting|requested review/.test(text)) status = "pending";

      const img = span.querySelector("img.avatar");
      const link = span.querySelector("a.assignee");
      const name = span.getAttribute("data-assignee-name");
      if (isBot(span, link, name)) continue;
      out.push({
        name,
        avatar: img ? img.getAttribute("src") : null,
        href: link ? link.getAttribute("href") : null,
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
    let cell = row.querySelector(".gh-pr-reviewers");
    if (!cell) {
      cell = document.createElement("div");
      cell.className = "gh-pr-reviewers";
      Object.assign(cell.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: `${AVATAR_GAP}px`,
        flexShrink: "0",
        height: `${AVATAR_SIZE}px`,
        padding: "0 2px", // room for the 2px status ring on the outer avatars
        boxSizing: "content-box",
        marginLeft: "auto",
      });
    }
    // relocate if React replaced the metadata container (e.g. switching compact <-> comfortable)
    if (cell.parentElement !== meta) meta.appendChild(cell);
    return cell;
  }

  const initial = (name) => (name && name.trim()[0] ? name.trim()[0].toUpperCase() : "?");

  function authorLogin(row) {
    const link = row.querySelector('[data-testid="author-filter-link"]');
    if (!link) return null;
    try {
      // href is "...?q=is%3Apr+...author%3A<login>"
      const q = decodeURIComponent(link.getAttribute("href") || "");
      const m = /author:([^&\s]+)/.exec(q);
      if (m) return m[1];
    } catch (err) {
      // fall through to the label
    }
    // GitHub may render a <button> without href; its label is "Filter by author <Name (login)|login>"
    const label = (link.getAttribute("aria-label") || "").replace(/^Filter by author\s+/, "").trim();
    const paren = /\(([\w-]+(?:\[bot\])?)\)$/.exec(label);
    if (paren) return paren[1];
    return /^[\w-]+(?:\[bot\])?$/.test(label) ? label : null;
  }

  function addOpener(row) {
    const title = row.querySelector("[data-listview-item-title-container]");
    if (!title) return;
    // inside the <h3> so it flows with the title text in both compact and comfortable layouts
    const heading = title.querySelector("h3");
    const host = heading || title;
    // drop openers left elsewhere in the row (e.g. after React re-rendered around them)
    for (const stray of row.querySelectorAll(".gh-pr-opener")) {
      if (stray.parentElement !== host) stray.remove();
    }
    if (host.querySelector(":scope > .gh-pr-opener")) return;
    const login = authorLogin(row);
    if (!login) return;
    // clicking filters the list by author, like GitHub's own link; when GitHub renders that as a
    // <button> without href, build the same search
    const link = row.querySelector('[data-testid="author-filter-link"]');
    let filterHref = link && link.getAttribute("href");
    if (!filterHref) {
      const url = new URL(`/${owner}/${repo}/pulls`, location.origin);
      url.searchParams.set("q", `is:pr is:open author:${login}`);
      filterHref = url.href;
    }

    const a = document.createElement("a");
    a.className = "gh-pr-opener";
    a.href = filterHref;
    a.title = `Filter by author ${login}`;
    Object.assign(a.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      verticalAlign: "middle",
      marginRight: "8px",
    });

    const img = document.createElement("img");
    img.src = `https://github.com/${encodeURIComponent(login)}.png?size=48`;
    img.alt = login;
    img.width = 20;
    img.height = 20;
    Object.assign(img.style, {
      borderRadius: "50%",
      display: "block",
      background: "var(--bgColor-muted, #30363d)",
    });
    img.addEventListener(
      "error",
      () => {
        img.remove();
        a.textContent = initial(login);
        Object.assign(a.style, {
          width: "20px",
          height: "20px",
          borderRadius: "50%",
          fontSize: "11px",
          fontWeight: "600",
          color: "#fff",
          background: "var(--fgColor-muted, #8b949e)",
        });
      },
      { once: true },
    );
    a.appendChild(img);

    host.insertBefore(a, host.firstChild);
  }

  // clicking a reviewer searches this repo's open PRs: still waiting on them if their review is
  // pending, otherwise the ones they reviewed. Teams can only be requested, never review.
  function reviewerSearch(r) {
    const team = /^\/orgs\/([^/]+)\/teams\/([^/]+)/.exec(r.href || "");
    let filter;
    let what;
    if (team) {
      filter = `team-review-requested:${team[1]}/${team[2]}`;
      what = "open PRs requesting review from this team";
    } else if (r.status === "pending") {
      filter = `review-requested:${r.name}`;
      what = `open PRs waiting on ${r.name}'s review`;
    } else {
      filter = `reviewed-by:${r.name}`;
      what = `open PRs reviewed by ${r.name}`;
    }
    const url = new URL(`/${owner}/${repo}/pulls`, location.origin);
    url.searchParams.set("q", `is:pr is:open sort:updated-desc ${filter}`);
    return { href: url.href, what };
  }

  function avatarNode(r) {
    const s = STATUS[r.status] || STATUS.pending;
    const search = reviewerSearch(r);
    const a = document.createElement("a");
    a.href = search.href;
    a.title = `${r.name} - ${s.label}\nClick to show ${search.what}`;
    Object.assign(a.style, {
      position: "relative", // anchors the status badge
      display: "inline-flex",
      alignItems: "center",
      flexShrink: "0",
      width: `${AVATAR_SIZE}px`,
      height: `${AVATAR_SIZE}px`,
      lineHeight: "0",
    });

    if (r.avatar) {
      const img = document.createElement("img");
      img.src = r.avatar;
      img.alt = r.name;
      img.width = AVATAR_SIZE;
      img.height = AVATAR_SIZE;
      Object.assign(img.style, {
        borderRadius: "50%",
        boxShadow: `0 0 0 2px ${s.color}`,
        background: "var(--bgColor-default, #fff)",
        display: "block",
      });
      a.appendChild(img);
    } else {
      const span = document.createElement("span");
      span.textContent = initial(r.name);
      Object.assign(span.style, {
        width: `${AVATAR_SIZE}px`,
        height: `${AVATAR_SIZE}px`,
        lineHeight: "normal",
        borderRadius: "50%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "11px",
        fontWeight: "600",
        color: "#fff",
        background: s.color,
      });
      a.appendChild(span);
    }
    if (s.icon) a.appendChild(statusBadge(s.icon));
    return a;
  }

  function statusBadge(d) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    for (const [key, value] of Object.entries({
      viewBox: "0 0 16 16",
      width: String(BADGE_SIZE),
      height: String(BADGE_SIZE),
      fill: "currentColor",
      "aria-hidden": "true",
      focusable: "false",
    })) {
      svg.setAttribute(key, value);
    }
    Object.assign(svg.style, {
      position: "absolute",
      right: "-4px",
      bottom: "-4px",
      boxSizing: "border-box",
      padding: "1px",
      borderRadius: "50%",
      background: "var(--bgColor-default, #fff)",
      border: "1px solid var(--borderColor-default, #d0d7de)",
      color: "var(--fgColor-muted, #8b949e)",
      pointerEvents: "none",
    });
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
    return svg;
  }

  function renderCell(cell, reviewers) {
    cell.textContent = "";
    // dismissed reviews matter least, so they're the first to fall into the "+N" overflow;
    // sort is stable, so everyone else keeps the sidebar's order
    reviewers = [...reviewers].sort((a, b) => (a.status === "dismissed") - (b.status === "dismissed"));
    // up to MAX_AVATARS fit; beyond that the last slot becomes a "+N" circle
    const shown = reviewers.length > MAX_AVATARS ? reviewers.slice(0, MAX_AVATARS - 1) : reviewers;
    for (const r of shown) cell.appendChild(avatarNode(r));
    const rest = reviewers.slice(shown.length);
    if (rest.length) {
      const more = document.createElement("span");
      more.textContent = `+${rest.length}`;
      more.title = rest.map((r) => r.name).join(", ");
      Object.assign(more.style, {
        width: `${AVATAR_SIZE}px`,
        height: `${AVATAR_SIZE}px`,
        flexShrink: "0",
        borderRadius: "50%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 0 0 2px var(--borderColor-default, #d0d7de)",
        background: "var(--bgColor-muted, #f6f8fa)",
        fontSize: "10px",
        fontWeight: "600",
        lineHeight: "normal",
        color: "var(--fgColor-muted, #8b949e)",
        cursor: "default",
      });
      cell.appendChild(more);
    }
  }

  function apply(row, reviewers) {
    const meta = row.querySelector('[class*="MetadataContainer"]');
    if (!meta) {
      if (DEBUG) console.warn("[gh-pr-reviewers] no MetadataContainer in row, skipping");
      return;
    }

    const cell = ensureCell(row, meta);
    const visible = visibleReviewers(reviewers);
    const has = visible.length > 0;
    // order-independent, so a reshuffled sidebar doesn't force a repaint
    const sig = has
      ? visible
          .map((r) => r.name + ":" + r.status)
          .sort()
          .join("|")
      : "";
    if (cell.dataset.ghSig === sig && cell.dataset.ghDone === "1") return;
    cell.dataset.ghSig = sig;
    cell.dataset.ghDone = "1";

    row.classList.toggle("gh-pr-reviewers-row", has || !FALLBACK_TO_ASSIGNEES);
    cell.textContent = "";
    cell.style.display = has || !FALLBACK_TO_ASSIGNEES ? "flex" : "none";
    if (has) renderCell(cell, visible);
  }

  // ---- main loop ------------------------------------------------------------
  function collectRows() {
    const rows = new Map(); // num -> <li>
    // runs every frame while the page renders, so only look at links that can be PR links
    for (const a of document.querySelectorAll('a[href*="/pull/"]')) {
      let pathname;
      try {
        pathname = new URL(a.href, location.href).pathname;
      } catch (err) {
        continue;
      }
      const m = pullHref.exec(pathname);
      if (!m) continue;
      const li = a.closest("li");
      if (li && !rows.has(m[1])) rows.set(m[1], li);
    }
    return rows;
  }

  let lastHref = null;
  function run() {
    if (!syncRepo()) {
      lastHref = null;
      return;
    }
    if (location.href !== lastHref) {
      // a new list (or the same one revisited): refetch so reviewers aren't stale; the stored
      // copy still paints instantly while the fetches run
      lastHref = location.href;
      cache.clear();
    }
    const rows = collectRows();
    if (DEBUG) console.log("[gh-pr-reviewers] run: matched", rows.size, "PR row(s)", [...rows.keys()]);
    if (rows.size === 0 && DEBUG) {
      console.warn(
        "[gh-pr-reviewers] no rows matched. Sample pull hrefs:",
        [...document.querySelectorAll('a[href*="/pull/"]')].slice(0, 3).map((a) => a.getAttribute("href")),
      );
    }
    for (const [num, row] of rows) {
      // flag the row (CSS hides its assignees instantly), then fill reviewers
      const meta = row.querySelector('[class*="MetadataContainer"]');
      if (!meta) continue;
      row.classList.add("gh-pr-reviewers-row");
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

  // ---- lifecycle ------------------------------------------------------------
  // Off the PR list the script only listens for URL changes: no DOM observer, no stylesheet.
  // The observer is attached on entering a PR list and disconnected on leaving it.
  // Runs are batched to the next animation frame, which still comes before that frame paints, so
  // rows GitHub renders show up already processed. run() is idempotent and only touches the DOM
  // when something is missing, so it settles once the page stops changing.
  let runFrame = null;
  function queueRun() {
    if (runFrame) return;
    runFrame = requestAnimationFrame(() => {
      runFrame = null;
      run();
    });
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
        // documentElement, not body: at document-start the body doesn't exist yet
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      queueRun(); // the list may already be rendered, or render without further mutations
    } else if (observer) {
      observer.disconnect();
      observer = null;
      // its selectors target GitHub's shared list components, so left in place it would also hide
      // assignees on e.g. the issues list, and cost style matching on every page after
      hideStyle.remove();
      run(); // tidies up: forgets the last list URL
    }
  }

  // GitHub navigates with history.pushState, which fires no event of its own. The Navigation API
  // reports it; where that's missing, fall back to a cheap once-a-second URL comparison.
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("currententrychange", onUrlChange);
  } else {
    setInterval(onUrlChange, 1000);
  }
  window.addEventListener("popstate", onUrlChange);
  document.addEventListener("turbo:load", onUrlChange);

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Configure hidden reviewers", () => {
      const input = prompt("Reviewers to hide (comma-separated, case-insensitive):", ignoreList.join(", "));
      if (input === null) return;
      ignoreList = input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        GM_setValue("ignoreReviewers", ignoreList);
      } catch (err) {
        /* storage unavailable */
      }
      // force a repaint with the new filter
      document.querySelectorAll(".gh-pr-reviewers").forEach((cell) => {
        delete cell.dataset.ghSig;
        delete cell.dataset.ghDone;
      });
      run();
    });
  }

  onUrlChange();
})();

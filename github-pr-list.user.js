// ==UserScript==
// @name         GitHub PR list — Show opener avatar on the left, and reviewers instead of assignees on the right
// @namespace    https://github.com/danieleformichelli/tampermonkey-scripts
// @version      1.0.6
// @description  Show opener avatar on the left, reviewers in place of the assignees, and keep other people's drafts off unfiltered lists.
// @author       Daniele Formichelli
// @match        https://github.com/*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // ---- config ---------------------------------------------------------------
  const MAX_AVATARS = 5; // avatars before a "+N" badge
  const AVATAR_SIZE = 20; // px
  const AVATAR_GAP = 8; // px between reviewer avatars; the 2px status ring eats into it on both sides
  const CELL_WIDTH = MAX_AVATARS * AVATAR_SIZE + (MAX_AVATARS - 1) * AVATAR_GAP;
  const CONCURRENCY = 25; // parallel sidebar fetches (one PR-list page)
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

  // ---- context --------------------------------------------------------------
  const DEBUG = false;
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

  function redirectUrlIfNeeded() {
    const BARE_PULLS_PATH = /^\/[^/]+\/[^/]+\/pulls\/?$/;
    if (!BARE_PULLS_PATH.test(location.pathname)) return null;
    const url = new URL(location.href);
    if (url.searchParams.get("q")) return null;
    url.searchParams.set("q", "is:pr is:open (draft:false OR author:@me)");
    return url.href;
  }

  // a stylesheet survives React replacing nodes or resetting the row's className, and applies from the first paint (the script runs at
  // document-start), before any row is processed.
  // - assignees are an alignRight item (comfortable) or a fixed-width metadataAssignees column (compact): hide them, the opener avatar
  //   already says who owns the PR
  // - compact view gives the cell a fixed width so its columns line up across rows; until a row gets its cell, an empty placeholder of that
  //   size holds its place, so the columns don't jump. Comfortable view has no columns, so the cell just fits its avatars, right-aligned
  // - switching layouts makes React append the new layout's metadata after our cell, so `order` keeps the cell last without moving the node
  // - the cell centres vertically like GitHub's own metadata items, so it lines up with the comment count in both layouts
  const ROW = 'ul[data-listview-component="items-list"] > li';
  const COMPACT_ROW = `:is(ul[data-density="compact"] > li, li[class*="listItemCompact"])`;
  const hideStyle = document.createElement("style");
  hideStyle.textContent = `
    ${ROW} > :last-child > [class*="alignRight"],
    ${ROW} > :last-child > [class*="metadataAssignees"] { display: none !important; }
    ${COMPACT_ROW} > :last-child:not([data-listview-item-title-container]):not(:has(> .gh-pr-reviewers))::after {
      content: ""; flex: 0 0 ${CELL_WIDTH + 4}px; height: ${AVATAR_SIZE}px;
      align-self: center; order: 9999; margin-left: -16px;
    }
    li > .gh-pr-opener { display: none !important; }
    .gh-pr-reviewers { align-self: center; order: 9999; }
    /* compact cells are a fixed 72px with centred content, so the comment count before us leaves
       ~20px empty on its right; pull the reviewers into it (the 8px column gap still separates them) */
    ${COMPACT_ROW} .gh-pr-reviewers { width: ${CELL_WIDTH}px; margin-left: -16px !important; }
  `;
  // attached by onUrlChange on the first visit to a PR list

  // ---- fetch reviewers from the same-origin sidebar partial -----------------
  // keyed "owner/repo#num": in-page navigation can switch repos while fetches are in flight. Cleared on every URL change, so returning to
  // the list refetches instead of showing stale data.
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
  function isBot(span, link, name) {
    const href = link ? link.getAttribute("href") || "" : "";
    const type = span.getAttribute("data-hovercard-type") || "";
    return href.startsWith("/apps/") || type === "bot" || type === "copilot" || /\[bot]$/i.test(name);
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
    // the label is "Filter by author <Name (login)|login>"; GitHub may render the link as a <button> without href
    const label = (link.getAttribute("aria-label") || "").replace(/^Filter by author\s+/, "").trim();
    const paren = /\(([\w-]+(?:\[bot])?)\)$/.exec(label);
    if (paren) return paren[1];
    if (/^[\w-]+(?:\[bot])?$/.test(label)) return label;
    try {
      // href is "...?q=is%3Apr+...author%3A<login>". The current search can already carry an author qualifier (e.g. the draft query's
      // author:@me), so the row's author is the last one.
      const q = decodeURIComponent(link.getAttribute("href") || "");
      const m = [...q.matchAll(/author:([\w-]+(?:\[bot])?)/g)].pop();
      if (m) return m[1];
    } catch (err) {
      // fall through
    }
    return null;
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
    // GitHub's own author href appends the qualifier to the current search, which now already carries one (the draft query's author:@me)
    const url = new URL(`/${owner}/${repo}/pulls`, location.origin);
    url.searchParams.set("q", `is:pr is:open sort:updated-desc author:${login}`);

    const a = document.createElement("a");
    a.className = "gh-pr-opener";
    a.href = url.href;
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

  function reviewerSearch(r) {
    const team = /^\/orgs\/([^/]+)\/teams\/([^/]+)/.exec(r.href || "");
    let filter;
    let what;
    if (team) {
      filter = `team-review-requested:${team[1]}/${team[2]}`;
      what = "open PRs requesting review from this team";
    } else {
      filter = `(review-requested:${r.name} OR reviewed-by:${r.name})`;
      what = `open PRs waiting on ${r.name}'s review or already reviewed by them`;
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
      width: String(12),
      height: String(12),
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

  // The row's metadata column (comments, checks, ...; where the reviewers cell goes). Its class name is generated and changes, so it is
  // found structurally: the row's last child, unless that child is the title or carries the timestamp (i.e. it is the main content) — then
  // the layout has no metadata column and the cell goes in the row itself, rather than leaving the row untouched.
  function metadataContainer(row) {
    const last = row.lastElementChild;
    if (!last || last.matches("[data-listview-item-title-container]") || last.querySelector('[data-testid="timestamp-container"]'))
      return row;
    return last;
  }

  function apply(row, reviewers) {
    const cell = ensureCell(row, metadataContainer(row));
    const has = reviewers.length > 0;
    // order-independent, so a reshuffled sidebar doesn't force a repaint
    const sig = has
      ? reviewers
          .map((r) => r.name + ":" + r.status)
          .sort()
          .join("|")
      : "";
    if (cell.dataset.ghSig === sig && cell.dataset.ghDone === "1") return;
    cell.dataset.ghSig = sig;
    cell.dataset.ghDone = "1";

    row.classList.add("gh-pr-reviewers-row");
    cell.textContent = "";
    cell.style.display = "flex";
    if (has) renderCell(cell, reviewers);
  }

  // ---- main loop ------------------------------------------------------------
  function collectRows() {
    const rows = new Map(); // num -> <li>
    // runs every frame while the page renders, so only look at links that can be PR links. The row must be one of the list's own items:
    // a link to the PR also sits in overlays (e.g. a check's "Details" target), and its list item is not a PR row
    for (const a of document.querySelectorAll('a[href*="/pull/"]')) {
      let pathname;
      try {
        pathname = new URL(a.href, location.href).pathname;
      } catch (err) {
        continue;
      }
      const m = pullHref.exec(pathname);
      if (!m) continue;
      const li = a.closest(ROW);
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
      // a new list (or the same one revisited): refetch so reviewers aren't stale; the stored copy still paints instantly while fetching
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
      row.classList.add("gh-pr-reviewers-row");
      ensureCell(row, metadataContainer(row));
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
  // Off the PR list the script only listens for URL changes: no DOM observer, and the stylesheet is dropped as soon as the list it styles
  // leaves the document. The observer is attached on entering a PR list and disconnected on leaving it. Runs are batched to the next
  // animation frame, which still comes before that frame paints, so rows GitHub renders show up already processed. run() is idempotent and
  // only touches the DOM when something is missing, so it settles once the page stops changing.
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

  // The URL changes before GitHub swaps the page content, so the stylesheet has to outlive the URL change: pulled while the list is still
  // on screen, it takes the cell's `align-self: center` away — the avatars drop to the top of the metadata column, one avatar higher — and
  // lets the assignees it hides reappear for the length of the navigation. It is dropped once the list leaves the document, which is the
  // point where the next page's content is in place.
  let styleRelease = null;
  let styleReleaseTimer = null;
  function stopStyleRelease() {
    if (styleRelease) styleRelease.disconnect();
    if (styleReleaseTimer) clearTimeout(styleReleaseTimer);
    styleRelease = null;
    styleReleaseTimer = null;
  }
  function releaseStyleWithList() {
    if (styleRelease) return; // a pending release still covers this navigation
    const list = document.querySelector('ul[data-listview-component="items-list"]');
    if (!list) {
      hideStyle.remove();
      return;
    }
    const release = () => {
      stopStyleRelease();
      hideStyle.remove();
    };
    styleRelease = new MutationObserver(() => {
      if (!list.isConnected) release();
    });
    styleRelease.observe(document.documentElement, { childList: true, subtree: true });
    // the selectors target GitHub's shared list components, so a page that somehow keeps its list mounted still drops the stylesheet
    styleReleaseTimer = setTimeout(release, 5000);
  }

  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const redirectUrl = redirectUrlIfNeeded();
    if (redirectUrl) {
      location.replace(redirectUrl);
      return;
    }
    if (PULLS_PATH.test(location.pathname)) {
      stopStyleRelease();
      if (!hideStyle.isConnected) (document.head || document.documentElement).appendChild(hideStyle);
      if (!observer) {
        observer = new MutationObserver(queueRun);
        // documentElement, not body: at document-start the body doesn't exist yet
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      queueRun(); // the list may already be rendered, or render without further mutations
    } else {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (hideStyle.isConnected) releaseStyleWithList();
      run(); // tidies up: forgets the last list URL
    }
  }

  // GitHub navigates with history.pushState, which fires no event of its own. The Navigation API reports it; where that's missing, fall
  // back to a cheap once-a-second URL comparison.
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("currententrychange", onUrlChange);
  } else {
    setInterval(onUrlChange, 1000);
  }
  window.addEventListener("popstate", onUrlChange);
  document.addEventListener("turbo:load", onUrlChange);

  onUrlChange();
})();

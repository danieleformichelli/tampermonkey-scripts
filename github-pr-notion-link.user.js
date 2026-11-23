// ==UserScript==
// @name         GitHub PR — Link the [ABC-123] ticket ref to Notion
// @namespace    https://github.com/danieleformichelli/tampermonkey-scripts
// @version      1.0.1
// @description  A PR title that opens with a ticket ref, e.g. "[ABC-123] Fix the thing", gets the ref as a link to the ticket's Notion page, in PR lists and on the PR page. Settings, in the Tampermonkey menu on a GitHub page: color the link, open tickets in the Notion app.
// @author       Daniele Formichelli
// @match        https://github.com/*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// ==/UserScript==

(function () {
  "use strict";

  // ---- config ---------------------------------------------------------------
  // the ref a title can open with: up to 4 uppercase letters, a dash, a number
  const TICKET = /^\s*\[([A-Z]{1,4}-\d+)]/;
  const WEB_URL = (ref) => `https://notion.so/${ref}`; // works for everyone, and hands off to the desktop app where Notion can
  const APP_URL = (ref) => `notion://www.notion.so/${ref}`; // opens the desktop app directly, and does nothing without it
  // class of what the script inserts: the ref's link between its brackets
  const REF_CLASS = "gh-pr-ticket";

  // Settings, kept in Tampermonkey's storage (see settings below), each a checkbox in Tampermonkey's menu. Both are off by default.
  const SETTINGS = {
    coloredLink: { label: "Color the ticket link", default: false }, // GitHub's link blue in place of the title's color
    appLink: { label: "Open tickets in the Notion app", default: false }, // APP_URL in place of WEB_URL
  };
  const setting = (key) => GM_getValue(key, SETTINGS[key].default);

  // Colors come from GitHub's theme variables, so they follow the light or dark theme. Should GitHub rename one, the ref falls back to the
  // color it inherits from the title.
  const TITLE_COLOR = "var(--fgColor-default)"; // the variable GitHub's title links use
  const LINK_COLOR = "var(--fgColor-accent)"; // the variable GitHub's own links use

  // ---- context --------------------------------------------------------------
  // The pages whose titles can carry a ref: one PR, a repo's PR list, the list of my PRs. Elsewhere the script does nothing and observes
  // nothing.
  const PR_PAGES = [/^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/, /^\/[^/]+\/[^/]+\/pulls(?:\/|$)/, /^\/pulls(?:\/|$)/];
  const onPrPage = () => PR_PAGES.some((re) => re.test(location.pathname));

  // ---- titles ---------------------------------------------------------------
  // GitHub has changed the PR header's markup more than once, and the title is not always the first text of the element that holds it (the
  // header may put the number ahead of it), so the script goes by the title's own text rather than by one layout's classes: a heading, the
  // title span the header and its sticky copy share, and a list row's title. Headings inside comment bodies are not the PR's title.
  const TITLES = "h1, .js-issue-title, .markdown-title";
  const titleRoots = () => [
    ...[...document.querySelectorAll(TITLES)].filter((el) => !el.closest(".markdown-body")),
    ...[...document.querySelectorAll('a[data-testid="listitem-title-link"][href*="/pull/"]')].map((a) => a.parentElement),
  ];

  // ---- link -----------------------------------------------------------------
  // Where a ref's link points, by the "app link" setting. The web link opens in a new tab; the app link needs none, since the browser hands
  // it to the app, and a new tab would stay behind empty.
  function point(a, ref) {
    const app = setting("appLink");
    a.href = app ? APP_URL(ref) : WEB_URL(ref);
    if (app) a.removeAttribute("target");
    else a.target = "_blank";
  }

  // the links already in the page, when the setting changes
  function repoint() {
    for (const ref of document.querySelectorAll("." + REF_CLASS)) {
      const a = ref.querySelector("a");
      if (a) point(a, ref.dataset.ghTicket);
    }
  }

  function linkTitle(root) {
    // the title's text, leaving out the ref the script inserted
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest("." + REF_CLASS)) nodes.push(node);
    }
    const m = TICKET.exec(nodes.map((node) => node.nodeValue).join(""));
    if (!m) return; // no ref to link, or the link already holds it

    // where the ref starts, and the box the link goes in: links don't nest, so when GitHub wraps the title in a link ours goes ahead of
    // that link instead of into the title's text
    const at = nodes.find((node) => node.nodeValue.trim());
    if (!at) return;
    const anchor = at.parentElement.closest("a");
    const box = anchor ? anchor.parentElement : at.parentElement;
    const link = [...box.children].find((child) => child.classList.contains(REF_CLASS));

    // the ref comes off the title, and the link takes its place
    let count = m[0].length;
    for (const node of nodes) {
      if (!count) break;
      const value = node.nodeValue;
      node.nodeValue = value.slice(count);
      count = Math.max(0, count - value.length);
    }
    if (link && link.dataset.ghTicket === m[1]) return; // GitHub rendered the ref back into the title
    if (link) link.remove();

    // the brackets stay plain text around the link, like Bitbucket shows a Jira key: only the ref itself is the link
    const a = document.createElement("a");
    point(a, m[1]);
    a.rel = "noopener noreferrer";
    a.textContent = m[1];
    a.title = `Open ${m[1]} in Notion`;

    const ref = document.createElement("span");
    ref.className = REF_CLASS;
    ref.dataset.ghTicket = m[1];
    ref.append("[", a, "]");
    box.insertBefore(ref, anchor || at);
  }

  // The ref takes its place in the flow. The brackets keep the title's color; the link keeps it too or, with the "colored link" setting,
  // takes GitHub's link blue, and is underlined only on hover. GitHub colors every anchor, and the title around the ref may set its own
  // color and decoration; a plain class does not always outrank that, hence the !important. One style element, added once and rewritten
  // when the setting changes.
  const style = document.createElement("style");
  function paint() {
    const color = setting("coloredLink") ? LINK_COLOR : TITLE_COLOR;
    style.textContent = `
      .${REF_CLASS} { color: ${TITLE_COLOR} !important; }
      .${REF_CLASS} a { color: ${color} !important; text-decoration: none !important; }
      .${REF_CLASS} a:hover { text-decoration: underline !important; }
    `;
  }
  paint();
  (document.head || document.documentElement).appendChild(style);

  // ---- settings -------------------------------------------------------------
  // Settings live in Tampermonkey's storage, not in the code, so they survive script updates. Each one is a checkbox in the menu that
  // Tampermonkey's toolbar icon opens on a GitHub page. A change applies at once, in every open GitHub tab.
  // All the checkboxes are registered again on any change, since a re-registered one would otherwise move to the end of the menu.
  let menuIds = [];
  function registerMenu() {
    for (const id of menuIds) GM_unregisterMenuCommand(id);
    menuIds = Object.entries(SETTINGS).map(([key, { label }]) =>
      // the click reads the stored value afresh rather than the one the label was built from, which another tab may have changed since
      GM_registerMenuCommand(`${setting(key) ? "☑" : "☐"} ${label}`, () => GM_setValue(key, !setting(key))),
    );
  }
  registerMenu();

  // fires for a change made in this tab and in any other
  for (const key of Object.keys(SETTINGS)) {
    GM_addValueChangeListener(key, () => {
      paint();
      repoint();
      registerMenu();
    });
  }

  // ---- lifecycle ------------------------------------------------------------
  // GitHub navigates with history.pushState, which fires no event of its own. The Navigation API reports it; where that's missing, fall
  // back to a cheap once-a-second URL comparison. Runs are batched to the next animation frame, which still comes before that frame paints.
  let frame = null;
  function queueRun() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      for (const root of titleRoots()) if (root) linkTitle(root);
    });
  }

  let observer = null;
  let lastUrl = null;
  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (onPrPage()) {
      if (!observer) {
        observer = new MutationObserver(queueRun);
        // documentElement, not body: at document-start the body doesn't exist yet
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      queueRun(); // the title may already be rendered, or render without further mutations
    } else if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("currententrychange", onUrlChange);
  } else {
    setInterval(onUrlChange, 1000);
  }
  window.addEventListener("popstate", onUrlChange);
  document.addEventListener("turbo:load", onUrlChange);

  onUrlChange();
})();

// ==UserScript==
// @name         GitHub PR — Link the [ABC-123] ticket ref to Notion
// @namespace    https://github.com/danieleformichelli/tampermonkey-scripts
// @version      1.0.0
// @description  A PR title that opens with a ticket ref, e.g. "[ABC-123] Fix the thing", gets the ref as a link to the ticket's Notion page, in PR lists and on the PR page.
// @author       Daniele Formichelli
// @match        https://github.com/*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // ---- config ---------------------------------------------------------------
  // the ref a title can open with: up to 4 uppercase letters, a dash, a number
  const TICKET = /^\s*\[([A-Z]{1,4}-\d+)]/;
  const TICKET_URL = (ref) => `https://notion.so/${ref}`;
  const LINK = "gh-pr-ticket"; // class of the link the script inserts

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
  function linkTitle(root) {
    // the title's text, leaving out the link the script inserted
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest("." + LINK)) nodes.push(node);
    }
    const m = TICKET.exec(nodes.map((node) => node.nodeValue).join(""));
    if (!m) return; // no ref to link, or the link already holds it

    // where the ref starts, and the box the link goes in: links don't nest, so when GitHub wraps the title in a link ours goes ahead of
    // that link instead of into the title's text
    const at = nodes.find((node) => node.nodeValue.trim());
    if (!at) return;
    const anchor = at.parentElement.closest("a");
    const box = anchor ? anchor.parentElement : at.parentElement;
    const link = [...box.children].find((child) => child.classList.contains(LINK));

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

    const a = document.createElement("a");
    a.className = LINK;
    a.dataset.ghTicket = m[1];
    a.href = TICKET_URL(m[1]);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `[${m[1]}]`;
    a.title = `Open ${m[1]} in Notion`;
    box.insertBefore(a, anchor || at);
  }

  // The link takes the ref's place in the flow and reads as part of the title: it takes the title's own color (the variable GitHub's
  // title links use) and only shows itself on hover. GitHub colors every anchor, and a plain class does not outrank that, hence the
  // !important. One inert rule, added once.
  const style = document.createElement("style");
  style.textContent = `
    a.${LINK} { color: var(--fgColor-default, inherit) !important; text-decoration: none; }
    a.${LINK}:hover { text-decoration: underline; }
  `;
  (document.head || document.documentElement).appendChild(style);

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

// Script of the Branch Review view (see src/extension/review-view.ts). It posts the data-*
// attributes of clicked rows and buttons to the extension, replaces the view's content when the
// extension sends new HTML, and keeps the collapsed rows, the "Unresolved only" filter, the
// focused element and the scroll position across those updates (and, via setState, while the view
// is hidden). The tree has one Tab stop and keyboard navigation like VS Code's trees.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  /** `collapsed`: whether each node the user toggled is collapsed, by data-key */
  const state = { collapsed: {}, unresolvedOnly: false, ...vscode.getState() };
  /** getItemId of the tree row that Tab reaches (see updateTabStop) */
  let tabStopId;
  applyState();

  window.addEventListener("message", event => {
    if (event.data?.type === "render") {
      const focusId = getItemId(document.activeElement);
      const scrollY = window.scrollY;
      root.innerHTML = event.data.html;
      applyState();
      const focused = focusId && [...root.querySelectorAll("[tabindex], button, input")]
        .find(e => getItemId(e) === focusId);
      focused?.focus({ preventScroll: true });
      window.scrollTo(0, scrollY);
    }
  });

  document.addEventListener("click", event => {
    const toggle = event.target.closest("[data-toggle]");
    const target = event.target.closest("[data-action]");
    if (toggle)
      toggleNode(toggle.closest(".node"));
    else if (target)
      post(target);
  });

  document.addEventListener("change", event => {
    if (event.target.id === "unresolvedOnly") {
      state.unresolvedOnly = event.target.checked;
      saveAndApplyState();
    }
  });

  document.addEventListener("keydown", event => {
    const row = event.target.closest?.(".row");
    if (row && event.target === row && handleRowKey(row, event.key))
      event.preventDefault();
  });

  document.addEventListener("focusin", event => {
    if (event.target.matches?.(".tree .row"))
      updateTabStop(event.target);
  });

  /**
   * Handles a key pressed on a row (the review summary's or a tree row) like VS Code's trees do;
   * returns whether the key was used.
   */
  function handleRowKey(row, key) {
    const node = row.parentElement.classList.contains("node") ? row.parentElement : undefined;
    const isExpanded = node !== undefined && !node.classList.contains("collapsed");
    const rows = getShownRows();
    const index = rows.indexOf(row);
    // Unless they expand/collapse `row`, ArrowRight goes to its first child and ArrowLeft to
    // its parent
    const targets = { ArrowDown: rows[index + 1], ArrowUp: rows[index - 1], Home: rows[0], End: rows.at(-1),
      ArrowRight: isExpanded && node.contains(rows[index + 1]) ? rows[index + 1] : undefined,
      ArrowLeft: (node ?? row).parentElement.closest(".node")?.querySelector(":scope > .row") };
    if (key === "Enter" || key === " ") {
      if (row.dataset.action)
        post(row);
      else if (node)
        toggleNode(node);
    } else if (node && (key === "ArrowRight" && !isExpanded || key === "ArrowLeft" && isExpanded)) {
      toggleNode(node);
    } else if (key in targets) {
      targets[key]?.focus();
    } else {
      return false;
    }
    return true;
  }

  /**
   * Makes `row` (by default, the previous Tab stop if it is shown, else the first shown row) the
   * only tree row that Tab reaches, so that Tab moves past the tree; the arrow keys move within it.
   */
  function updateTabStop(row) {
    const rows = getShownRows();
    row ??= rows.find(r => getItemId(r) === tabStopId) ?? rows[0];
    tabStopId = row && getItemId(row);
    for (const r of root.querySelectorAll(".tree .row"))
      r.tabIndex = r === row ? 0 : -1;
  }

  /** Gets the tree's rows that are neither in a collapsed node nor hidden by the filter. */
  function getShownRows() {
    return [...root.querySelectorAll(".tree .row")].filter(r => !r.closest(".collapsed > .children")
      && !(state.unresolvedOnly && r.matches(".thread-row.resolved")));
  }

  /** Posts the data-* attributes of a clicked element, plus those of its row, to the extension. */
  function post(element) {
    const data = getData(element);
    vscode.postMessage({ action: data.action, group: data.group, path: data.path, thread: data.thread,
      command: data.command });
  }

  function toggleNode(node) {
    state.collapsed[node.dataset.key] = !node.classList.contains("collapsed");
    saveAndApplyState();
  }

  function saveAndApplyState() {
    vscode.setState(state);
    applyState();
  }

  /** Applies the filter and the user's collapsed/expanded choices (else the HTML's defaults). */
  function applyState() {
    for (const node of root.querySelectorAll(".node[data-key]")) {
      const isCollapsed = state.collapsed[node.dataset.key] ?? node.classList.contains("collapsed");
      const row = node.querySelector(":scope > .row");
      node.classList.toggle("collapsed", isCollapsed);
      row?.setAttribute("aria-expanded", String(!isCollapsed));
      row?.querySelector(":scope > .twistie")?.classList.replace(...isCollapsed
        ? ["codicon-chevron-down", "codicon-chevron-right"] : ["codicon-chevron-right", "codicon-chevron-down"]);
    }
    document.body.classList.toggle("unresolved-only", state.unresolvedOnly);
    const checkbox = document.getElementById("unresolvedOnly");
    if (checkbox)
      checkbox.checked = state.unresolvedOnly;
    updateTabStop();
  }

  /** Identifies a focusable element across re-renders by its tag and getData. */
  function getItemId(element) {
    return element && element !== document.body ? element.tagName + JSON.stringify(getData(element)) : undefined;
  }

  /** Gets the data-* attributes of an element, plus those of its row (if it is in one). */
  function getData(element) {
    return { ...element.closest(".row")?.dataset, ...element.dataset };
  }
})();

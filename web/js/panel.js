/**
 * Panel chrome: foldable sections (all screen sizes, state persisted), and
 * on phone-width viewports the panel becomes a bottom sheet with peek /
 * half / full snap states, dragged by the grip or the header.
 */

const FOLD_KEY = "debase.folds";
const SNAP_STATES = ["peek", "half", "full"];
const mqPhone = window.matchMedia("(max-width: 640px)");

export const isPhone = () => mqPhone.matches;

export function initPanelChrome({ onReveal } = {}) {
  const panel = document.getElementById("panel");
  const grip = document.getElementById("grip");
  const header = panel.querySelector("header");

  /* ---------- foldable sections ---------- */
  let folds = {};
  try {
    folds = JSON.parse(localStorage.getItem(FOLD_KEY)) || {};
  } catch {
    /* private mode / disabled storage */
  }
  const saveFolds = () => {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(folds));
    } catch {
      /* ignore */
    }
  };

  const setFolded = (sec, folded) => {
    sec.classList.toggle("folded", folded);
    sec.querySelector("h2").setAttribute("aria-expanded", String(!folded));
    folds[sec.id] = folded;
    saveFolds();
    if (!folded) onReveal?.(sec);
  };

  for (const sec of panel.querySelectorAll("section")) {
    const h2 = sec.querySelector("h2");
    if (!h2 || !sec.id) continue;
    h2.tabIndex = 0;
    h2.setAttribute("role", "button");
    h2.setAttribute("aria-expanded", String(!folds[sec.id]));
    if (folds[sec.id]) sec.classList.add("folded");
    const toggle = (ev) => {
      if (ev.target.closest("button.help")) return; // help ≠ fold
      setFolded(sec, !sec.classList.contains("folded"));
    };
    h2.addEventListener("click", toggle);
    h2.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggle(ev);
      }
    });
  }

  /* ---------- whole-panel collapse (desktop; the sheet covers phones) ---------- */
  const PANEL_KEY = "__panel";
  const setCollapsed = (c) => {
    panel.classList.toggle("collapsed", c);
    header.setAttribute("aria-expanded", String(!c));
    folds[PANEL_KEY] = c;
    saveFolds();
  };
  if (folds[PANEL_KEY]) panel.classList.add("collapsed");
  header.setAttribute("role", "button");
  header.tabIndex = 0;
  header.setAttribute("aria-expanded", String(!folds[PANEL_KEY]));
  header.addEventListener("click", () => {
    if (mqPhone.matches) return; // phone: header drives the sheet instead
    setCollapsed(!panel.classList.contains("collapsed"));
  });
  header.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && !mqPhone.matches) {
      ev.preventDefault();
      setCollapsed(!panel.classList.contains("collapsed"));
    }
  });

  const openSection = (id) => {
    const sec = document.getElementById(id);
    if (sec?.classList.contains("folded")) setFolded(sec, false);
    // a section revealed inside a collapsed panel would stay invisible
    if (!mqPhone.matches && panel.classList.contains("collapsed")) setCollapsed(false);
  };

  /* ---------- phone bottom sheet ---------- */
  let state = "peek";
  let shift = 0;

  const peekH = () => header.offsetTop + header.offsetHeight; // grip + header
  const maxShift = () => Math.max(0, panel.offsetHeight - peekH());
  const shiftFor = (s) =>
    s === "full" ? 0 : s === "half" ? Math.round(maxShift() / 2) : maxShift();

  const applyShift = (px) => {
    shift = px;
    panel.style.setProperty("--sheet-shift", `${px}px`);
  };

  const setSheet = (s) => {
    state = s;
    if (!mqPhone.matches) return;
    document.documentElement.style.setProperty("--peek-h", `${peekH()}px`);
    applyShift(shiftFor(s));
  };

  const teardownSheet = () => {
    panel.style.removeProperty("--sheet-shift");
    panel.classList.remove("dragging");
  };

  // drag on grip or header; a tap (no real movement) toggles peek ↔ half
  let dragBase = null;
  let startY = 0;
  let moved = false;
  const onDown = (ev) => {
    if (!mqPhone.matches) return;
    dragBase = shift;
    startY = ev.clientY;
    moved = false;
    panel.classList.add("dragging");
    ev.currentTarget.setPointerCapture(ev.pointerId);
  };
  const onMove = (ev) => {
    if (dragBase === null) return;
    const dy = ev.clientY - startY;
    if (Math.abs(dy) > 6) moved = true;
    applyShift(Math.max(0, Math.min(maxShift(), dragBase + dy)));
  };
  const onUp = () => {
    if (dragBase === null) return;
    dragBase = null;
    panel.classList.remove("dragging");
    if (!moved) {
      setSheet(state === "peek" ? "half" : "peek");
      return;
    }
    let best = SNAP_STATES[0];
    for (const s of SNAP_STATES)
      if (Math.abs(shiftFor(s) - shift) < Math.abs(shiftFor(best) - shift)) best = s;
    setSheet(best);
  };
  for (const el of [grip, header]) {
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  const onModeChange = () => {
    if (mqPhone.matches) setSheet(state);
    else teardownSheet();
  };
  mqPhone.addEventListener("change", onModeChange);
  window.addEventListener("resize", () => {
    if (mqPhone.matches) setSheet(state); // re-measure snap heights
  });
  onModeChange();

  return { openSection, setSheet, sheetState: () => state };
}

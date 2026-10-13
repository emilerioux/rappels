/* ============================================================
   ui.js — la feuille du bas (sheet) et les toasts.

   La feuille monte sur un ressort critique ; on l'attrape par son
   en-tête, elle suit le doigt au pixel, résiste en élastique vers
   le haut, et au relâchement la vitesse projetée décide : on la
   renvoie en bas ou elle revient. Rien n'est verrouillé pendant
   l'animation — on peut la rattraper en pleine descente.
   ============================================================ */

import { Spring, project, rubberband, tracker, capture, REDUCED } from "./motion.js";

const sheet = document.getElementById("sheet");
const scrim = document.getElementById("scrim");
const toastEl = document.getElementById("toast");

let h = 1, isOpen = false, onClosed = null;

const spring = new Spring(0, {
  response: 0.38, damping: 1, restDelta: 0.5,
  onUpdate: (y) => {
    sheet.style.transform = `translate3d(0,${y}px,0)`;
    scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - y / h)));
  },
  onRest: () => {
    if (isOpen) return;
    sheet.hidden = true; scrim.hidden = true; sheet.innerHTML = "";
    document.body.classList.remove("sheet-open");
    const f = onClosed; onClosed = null; if (f) f();
  },
});

/* html = contenu complet (en-tête .sheet-head + .sheet-body).
   Si une feuille est déjà ouverte, on remplace son contenu sur
   place : on passe d'une étape à l'autre sans redescendre. */
export function openSheet(html, mount, { onClose } = {}) {
  const wasHidden = sheet.hidden;
  sheet.innerHTML = `<div class="grabber" aria-hidden="true"></div>${html}`;
  sheet.hidden = false; scrim.hidden = false;
  document.body.classList.add("sheet-open");
  h = sheet.offsetHeight || 1;
  if (wasHidden) spring.hold(h);
  else if (!REDUCED.matches) {
    const b = sheet.querySelector(".sheet-body");
    if (b) b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
  }
  isOpen = true;
  onClosed = onClose || null;
  spring.to(0, { damping: 1 });

  sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheet()));
  bindDrag(sheet.querySelector(".sheet-head"));
  if (mount) mount(sheet);
  const first = sheet.querySelector("[autofocus]");
  if (first && matchMedia("(pointer: fine)").matches) first.focus();
}

export function closeSheet(velocity = 0) {
  if (!isOpen) return;
  isOpen = false;
  if (document.activeElement && sheet.contains(document.activeElement)) document.activeElement.blur();
  spring.to(h, { velocity, damping: 1 });
}

export const sheetIsOpen = () => isOpen;

function bindDrag(head) {
  if (!head) return;
  let g = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, a")) return;
    capture(head, e.pointerId);
    g = { id: e.pointerId, y0: e.clientY, from: spring.x, tr: tracker() };
    g.tr.add(e.clientY, e.timeStamp);
  });
  head.addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== g.id) return;
    g.tr.add(e.clientY, e.timeStamp);
    let y = g.from + e.clientY - g.y0;
    if (y < 0) y = -rubberband(-y, h);
    spring.hold(y);
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const v = g.tr.velocity();
    g = null;
    if (spring.x + project(v) > h * 0.45) closeSheet(v);
    else spring.to(0, { velocity: v, damping: 1 });
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
}

scrim.addEventListener("click", () => closeSheet());
addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

/* ── Toast ─────────────────────────────────────────────────── */

let toastTimer = 0;
export function toast(msg, { action, onAction, ms = 3800 } = {}) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ""}`;
  const b = toastEl.querySelector("button");
  if (b) b.addEventListener("click", () => { hideToast(); onAction(); });
  toastEl.classList.add("show");
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { clearTimeout(toastTimer); toastEl.classList.remove("show"); }

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

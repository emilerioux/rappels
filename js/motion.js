/* ============================================================
   motion.js — ressorts, projection de momentum, élastique.
   Repris de Reps : amortissement + réponse (comme SwiftUI),
   toujours repris depuis la valeur à l'écran, donc interruptible.
   ============================================================ */

export const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");

const running = new Set();
let rafId = 0, lastT = 0;

function frame(now) {
  const dt = Math.min((now - lastT) / 1000, 1 / 30);
  lastT = now;
  for (const s of [...running]) s._advance(dt);
  rafId = running.size ? requestAnimationFrame(frame) : 0;
}
function wake() {
  if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(frame); }
}

export class Spring {
  constructor(value, opts = {}) {
    this.x = value; this.t = value; this.v = 0;
    this.response = opts.response ?? 0.4;
    this.damping  = opts.damping  ?? 1.0;
    this.rest     = opts.restDelta ?? 0.004;
    this.onUpdate = opts.onUpdate || (() => {});
    this.onRest   = opts.onRest || null;
  }
  get moving() { return running.has(this); }
  /* Nouvelle cible sans toucher à x ni v : c'est l'interruptibilité. */
  to(target, o = {}) {
    if (o.response !== undefined) this.response = o.response;
    if (o.damping  !== undefined) this.damping  = o.damping;
    this.t = target;
    if (o.velocity !== undefined) this.v = o.velocity;
    if (REDUCED.matches) {
      this.x = target; this.v = 0; running.delete(this);
      this.onUpdate(this.x); if (this.onRest) this.onRest();
      return;
    }
    running.add(this); wake();
  }
  /* Pendant un geste, le doigt écrit directement dans le ressort. */
  hold(value, velocity = 0) {
    running.delete(this);
    this.x = value; this.t = value; this.v = velocity;
    this.onUpdate(this.x);
  }
  _advance(dt) {
    const w = (2 * Math.PI) / this.response, z = this.damping;
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -w * w * (this.x - this.t) - 2 * z * w * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    if (Math.abs(this.v) < this.rest * 12 && Math.abs(this.t - this.x) < this.rest) {
      this.x = this.t; this.v = 0;
      running.delete(this);
      this.onUpdate(this.x);
      if (this.onRest) this.onRest();
      return;
    }
    this.onUpdate(this.x);
  }
}

/* Où le mouvement s'arrêterait tout seul — décélération exponentielle,
   la formule du code d'exemple « Designing Fluid Interfaces ». */
export const project = (v, d = 0.998) => (v / 1000) * d / (1 - d);

/* Résistance progressive au-delà d'une limite, plutôt qu'un mur. */
export const rubberband = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));

/* Historique court de positions → vitesse au relâchement. */
export function tracker() {
  let pts = [];
  return {
    add(x, t) { pts.push([x, t]); if (pts.length > 8) pts.shift(); },
    velocity() {
      if (pts.length < 2) return 0;
      const end = pts[pts.length - 1];
      let start = pts[0];
      for (const p of pts) { if (end[1] - p[1] <= 90) { start = p; break; } }
      const dt = (end[1] - start[1]) / 1000;
      return dt > 0.004 ? (end[0] - start[0]) / dt : 0;
    },
  };
}

export function capture(el, id) { try { el.setPointerCapture(id); } catch (_) {} }

/* Haptique — réservée aux moments qui comptent. */
export const buzz = (p) => { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (_) {} } };

/* Petit rebond d'échelle réutilisable. */
export function pop(el, from = 1.07, damping = 0.55) {
  if (!el || REDUCED.matches) return;
  if (!el._pop) {
    el._pop = new Spring(1, { response: 0.34, damping, restDelta: 0.002,
      onUpdate: (v) => { el.style.transform = v === 1 ? "" : `scale(${v})`; } });
  }
  el._pop.damping = damping;
  el._pop.hold(from);
  el._pop.to(1);
}

/* ============================================================
   voice.js — enregistre une phrase au micro.

   Pourquoi pas la reconnaissance vocale de Safari ? Sur iPhone,
   elle est bloquée quand l'app est ouverte depuis l'écran
   d'accueil. On enregistre donc nous-mêmes (MediaRecorder, en
   AAC/MP4 sur iPhone) et le serveur transcrit avec Whisper.

   L'enregistrement s'arrête tout seul après ~1,5 s de silence
   une fois qu'on a parlé (ou au toucher, ou après 20 s).
   ============================================================ */

let active = null;

export const supported = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
export const recording = () => !!active;
export const stop = () => active?.stop();

const TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

/* Renvoie une promesse de { blob, heard } (blob null si rien). */
export async function record({ onLevel, silenceMs = 1500, maxMs = 20000, giveUpMs = 7000 } = {}) {
  if (active) { active.stop(); return null; }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

  /* Niveau sonore : pour l'anneau qui respire et pour couper au silence. */
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try { await ctx.resume(); } catch (_) {}
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);

  let heard = false, raf = 0;
  const t0 = performance.now();
  let quietSince = t0;

  const finish = new Promise((resolve) => {
    rec.onstop = () => {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      active = null;
      onLevel?.(0);
      const blob = chunks.length ? new Blob(chunks, { type: rec.mimeType || type || "audio/mp4" }) : null;
      resolve({ blob: heard ? blob : null, heard });
    };
  });

  const halt = () => { if (rec.state !== "inactive") rec.stop(); };
  const tick = () => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / buf.length);
    onLevel?.(Math.min(1, rms * 7));
    const now = performance.now();
    if (rms > 0.035) { heard = true; quietSince = now; }
    if ((heard && now - quietSince > silenceMs) || now - t0 > maxMs || (!heard && now - t0 > giveUpMs)) { halt(); return; }
    raf = requestAnimationFrame(tick);
  };

  rec.start(250);
  tick();
  active = { stop: halt };
  return finish;
}

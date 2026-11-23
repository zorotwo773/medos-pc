/* ──────────────────────────────────────────────────────────────
   MedOS ACLS — audio cues. Everything is synthesized locally
   (WebAudio beeps + SpeechSynthesis voice) so the code assistant
   works fully offline; no audio assets to ship.
   ────────────────────────────────────────────────────────────── */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(at: number, freq: number, dur: number, gain = 0.16, type: OscillatorType = "sine") {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur + 0.03);
}

/** Soft double-chime — informational (window opening, cycle warning). */
export function chime() {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  tone(t, 880, 0.16);
  tone(t + 0.18, 1175, 0.22);
}

/** Urgent triple-beep — something is due now. */
export function alarm() {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  for (let i = 0; i < 3; i++) tone(t + i * 0.22, 1568, 0.15, 0.2, "square");
}

/** Single low tick for the CPR metronome (110/min). */
export function metronomeTick(accent = false) {
  const ac = audio();
  if (!ac) return;
  tone(ac.currentTime, accent ? 1100 : 750, 0.045, accent ? 0.14 : 0.09, "square");
}

/** Positive resolution cue (ROSC). */
export function fanfare() {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  tone(t, 660, 0.18); tone(t + 0.16, 880, 0.18); tone(t + 0.32, 1320, 0.34);
}

/** Voice prompt via SpeechSynthesis; falls back to a chime. */
export function speak(text: string, enabled: boolean) {
  if (!enabled) return;
  try {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.pitch = 1;
      u.volume = 1;
      window.speechSynthesis.speak(u);
      return;
    }
  } catch { /* fall through */ }
  chime();
}

export function stopSpeaking() {
  try {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  } catch { /* ignore */ }
}

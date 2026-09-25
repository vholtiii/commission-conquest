/**
 * Synthesised hit cues. No asset files: a lazy AudioContext and a handful of
 * oscillators and noise buffers. The context opens on the first cue, which is
 * always inside the Next Turn click.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const live = new Set<AudioNode>();

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function setSfxVolume(volume: number): void {
  if (!master) context();
  if (master) master.gain.value = Math.max(0, Math.min(1, volume));
}

function noise(audio: AudioContext, seconds: number): AudioBufferSourceNode {
  const length = Math.floor(audio.sampleRate * seconds);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = audio.createBufferSource();
  src.buffer = buffer;
  return src;
}

function track(node: AudioNode, stopAt: number): void {
  live.add(node);
  window.setTimeout(() => live.delete(node), stopAt * 1000 + 50);
}

export function stopAll(): void {
  for (const node of live) {
    try {
      (node as AudioBufferSourceNode).stop?.();
    } catch {
      /* already stopped */
    }
  }
  live.clear();
}

export function gunshot(): void {
  const audio = context();
  if (!audio || !master || master.gain.value <= 0) return;
  const src = noise(audio, 0.18);
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(2200, audio.currentTime);
  filter.frequency.exponentialRampToValueAtTime(180, audio.currentTime + 0.16);
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.55, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18);
  src.connect(filter).connect(gain).connect(master);
  src.start();
  src.stop(audio.currentTime + 0.2);
  track(src, 0.2);
}

export function burst(count: number, interval = 0.09): void {
  for (let i = 0; i < count; i++) window.setTimeout(() => gunshot(), i * interval * 1000);
}

export function mutedShot(): void {
  const audio = context();
  if (!audio || !master || master.gain.value <= 0) return;
  const src = noise(audio, 0.12);
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 400;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.35, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
  src.connect(filter).connect(gain).connect(master);
  src.start();
  src.stop(audio.currentTime + 0.14);
  track(src, 0.14);
}

export function explosion(): void {
  const audio = context();
  if (!audio || !master || master.gain.value <= 0) return;
  const osc = audio.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(90, audio.currentTime);
  osc.frequency.exponentialRampToValueAtTime(28, audio.currentTime + 0.7);
  const src = noise(audio, 1.1);
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(800, audio.currentTime);
  filter.frequency.exponentialRampToValueAtTime(80, audio.currentTime + 1);
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.8, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 1.1);
  osc.connect(gain);
  src.connect(filter).connect(gain);
  gain.connect(master);
  osc.start();
  src.start();
  osc.stop(audio.currentTime + 0.8);
  src.stop(audio.currentTime + 1.15);
  track(src, 1.15);
}

export function fizzle(): void {
  const audio = context();
  if (!audio || !master || master.gain.value <= 0) return;
  const src = noise(audio, 0.4);
  const filter = audio.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 1200;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.15, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
  src.connect(filter).connect(gain).connect(master);
  src.start();
  src.stop(audio.currentTime + 0.42);
  track(src, 0.42);
}

export function glass(): void {
  const audio = context();
  if (!audio || !master || master.gain.value <= 0) return;
  const src = noise(audio, 0.25);
  const filter = audio.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 2500;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.3, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25);
  src.connect(filter).connect(gain).connect(master);
  src.start();
  src.stop(audio.currentTime + 0.28);
  track(src, 0.28);
}

export function engine(seconds: number): void {
  const audio = context();
  if (!audio || !master || master.gain.value <= 0) return;
  const osc = audio.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 55;
  const src = noise(audio, seconds);
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 240;
  const gain = audio.createGain();
  gain.gain.value = 0.08;
  osc.connect(filter);
  src.connect(filter);
  filter.connect(gain).connect(master);
  osc.start();
  src.start();
  osc.stop(audio.currentTime + seconds);
  src.stop(audio.currentTime + seconds);
  track(src, seconds);
}

export function siren(seconds: number): void {
  const audio = context();
  if (!audio || !master || master.gain.value <= 0) return;
  const osc = audio.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(520, audio.currentTime);
  const gain = audio.createGain();
  gain.gain.value = 0.08;
  const period = 0.35;
  for (let t = 0; t < seconds; t += period) {
    osc.frequency.setValueAtTime(520, audio.currentTime + t);
    osc.frequency.setValueAtTime(780, audio.currentTime + t + period / 2);
  }
  osc.connect(gain).connect(master);
  osc.start();
  osc.stop(audio.currentTime + seconds);
  track(osc, seconds);
}

export function crash(): void {
  const audio = context();
  if (!audio || !master || master.gain.value <= 0) return;
  const src = noise(audio, 0.3);
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.4, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.3);
  src.connect(gain).connect(master);
  src.start();
  src.stop(audio.currentTime + 0.32);
  track(src, 0.32);
}

export function footsteps(count: number): void {
  const audio = context();
  if (!audio || !master || master.gain.value <= 0) return;
  for (let i = 0; i < count; i++) {
    const when = audio.currentTime + i * 0.28;
    const osc = audio.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 90;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.12, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.1);
    osc.connect(gain).connect(master);
    osc.start(when);
    osc.stop(when + 0.12);
    track(osc, i * 0.28 + 0.12);
  }
}

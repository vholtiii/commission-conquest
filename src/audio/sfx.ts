/**
 * Synthesised hit cues. No asset files: a lazy AudioContext, a couple of
 * shared noise buffers, two generated convolution reverbs (street canyon and
 * back room) and a master compressor. The context opens on the first cue,
 * which is always inside the Next Turn click.
 *
 * Every cue is built from the same recipe a recorded impact has: a bright
 * millisecond transient, a fast-darkening body, a low-end thump, mild
 * saturation for punch, and a wet send so it lands in a space. Shots are
 * randomised in pitch, level and timing so bursts don't sound like a machine.
 */

type Space = "street" | "room" | "dry";

interface Rig {
  audio: AudioContext;
  /** Pre-compressor sum. Voices and reverbs land here. */
  bus: GainNode;
  /** Post-compressor volume. */
  master: GainNode;
  street: ConvolverNode;
  room: ConvolverNode;
  white: AudioBuffer;
  brown: AudioBuffer;
}

let rigInstance: Rig | null = null;
const live = new Set<AudioScheduledSourceNode>();
const curves = new Map<number, Float32Array>();

const FLOOR = 0.0005;

// ---------------------------------------------------------------------------
// Buffers

function buildNoise(audio: AudioContext, seconds: number, brown: boolean): AudioBuffer {
  const length = Math.floor(audio.sampleRate * seconds);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  let acc = 0;
  for (let i = 0; i < length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      acc = (acc + 0.02 * w) / 1.02;
      data[i] = acc * 3.5;
    } else {
      data[i] = w;
    }
  }
  return buffer;
}

/**
 * Exponentially decaying stereo noise with discrete early reflections and a
 * one-pole low-pass so the tail darkens the way real rooms do.
 */
function buildImpulse(audio: AudioContext, seconds: number, tone: number, reflections: number[]): AudioBuffer {
  const rate = audio.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = audio.createBuffer(2, length, rate);
  const decay = 6.9 / seconds;
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const s = (Math.random() * 2 - 1) * Math.exp(-decay * t);
      lp += (s - lp) * tone;
      data[i] = lp;
    }
    reflections.forEach((time, n) => {
      const idx = Math.floor((time + (ch ? 0.0015 : 0)) * rate);
      const g = 0.6 * Math.exp(-n * 0.45);
      for (let k = 0; k < 6 && idx + k < length; k++) {
        data[idx + k] += (Math.random() * 2 - 1) * g * (1 - k / 6);
      }
    });
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Rig

function rig(): Rig | null {
  if (typeof window === "undefined") return null;
  if (!rigInstance) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const audio = new AC();
    const bus = audio.createGain();
    const comp = audio.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.22;
    const master = audio.createGain();
    master.gain.value = 0.7;
    bus.connect(comp).connect(master).connect(audio.destination);

    const street = audio.createConvolver();
    street.buffer = buildImpulse(audio, 1.7, 0.28, [0.013, 0.029, 0.047, 0.071, 0.104, 0.138]);
    street.connect(bus);
    const room = audio.createConvolver();
    room.buffer = buildImpulse(audio, 0.45, 0.5, [0.006, 0.011, 0.019, 0.028]);
    room.connect(bus);

    rigInstance = {
      audio,
      bus,
      master,
      street,
      room,
      white: buildNoise(audio, 2, false),
      brown: buildNoise(audio, 2, true),
    };
  }
  if (rigInstance.audio.state === "suspended") void rigInstance.audio.resume();
  return rigInstance;
}

function ready(): Rig | null {
  const r = rig();
  return r && r.master.gain.value > 0 ? r : null;
}

export function setSfxVolume(volume: number): void {
  const r = rig();
  if (r) r.master.gain.value = Math.max(0, Math.min(1, volume));
}

export function stopAll(): void {
  for (const node of live) {
    try {
      node.stop();
    } catch {
      /* already stopped */
    }
  }
  live.clear();
}

// ---------------------------------------------------------------------------
// Building blocks

function track<T extends AudioScheduledSourceNode>(node: T): T {
  live.add(node);
  node.onended = () => live.delete(node);
  return node;
}

function chain(...nodes: AudioNode[]): AudioNode {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

function noise(r: Rig, at: number, seconds: number, brown = false): AudioBufferSourceNode {
  const src = r.audio.createBufferSource();
  src.buffer = brown ? r.brown : r.white;
  const offset = Math.random() * Math.max(0, src.buffer.duration - seconds - 0.02);
  src.start(at, offset, seconds + 0.01);
  return track(src);
}

function tone(r: Rig, type: OscillatorType, freq: number, at: number, until: number): OscillatorNode {
  const o = r.audio.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start(at);
  o.stop(until);
  return track(o);
}

function filter(r: Rig, type: BiquadFilterType, freq: number, q = 0.9): BiquadFilterNode {
  const f = r.audio.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function gain(r: Rig, value: number): GainNode {
  const g = r.audio.createGain();
  g.gain.value = value;
  return g;
}

/** tanh soft clipper. Adds the harmonics that make a synthetic hit feel heavy. */
function drive(r: Rig, amount: number): WaveShaperNode {
  let curve = curves.get(amount);
  if (!curve) {
    const n = 1024;
    curve = new Float32Array(n);
    const norm = Math.tanh(amount);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / norm;
    }
    curves.set(amount, curve);
  }
  const s = r.audio.createWaveShaper();
  s.curve = curve;
  s.oversample = "2x";
  return s;
}

/** Attack then exponential decay. attack 0 means an instant onset. */
function env(r: Rig, at: number, attack: number, peak: number, decay: number): GainNode {
  const g = r.audio.createGain();
  const p = Math.max(FLOOR, peak);
  if (attack > 0) {
    g.gain.setValueAtTime(FLOOR, at);
    g.gain.linearRampToValueAtTime(p, at + attack);
  } else {
    g.gain.setValueAtTime(p, at);
  }
  g.gain.exponentialRampToValueAtTime(FLOOR, at + attack + decay);
  return g;
}

/** Piecewise-linear level over time for sustained cues. */
function contour(r: Rig, points: [time: number, level: number][]): GainNode {
  const g = r.audio.createGain();
  g.gain.setValueAtTime(Math.max(FLOOR, points[0][1]), points[0][0]);
  for (let i = 1; i < points.length; i++) {
    g.gain.linearRampToValueAtTime(Math.max(FLOOR, points[i][1]), points[i][0]);
  }
  return g;
}

/** Output node for one cue: dry to the bus plus a wet send into a space. */
function voice(r: Rig, space: Space, wet: number, level = 1): GainNode {
  const out = gain(r, level);
  out.connect(r.bus);
  if (space !== "dry" && wet > 0) {
    chain(out, gain(r, wet), space === "street" ? r.street : r.room);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guns

function shot(r: Rig, at: number, level = 1, space: Space = "street"): void {
  const p = 0.92 + Math.random() * 0.16;
  const out = voice(r, space, space === "room" ? 0.5 : 0.38, 0.9);
  const sat = drive(r, 3);
  sat.connect(out);

  // Crack: the supersonic snap. A few milliseconds of bright broadband.
  chain(noise(r, at, 0.008), filter(r, "highpass", 2400 * p, 0.6), env(r, at, 0, 1.4 * level, 0.006), sat);

  // Blast: muzzle gases, darkening fast as the pressure wave passes.
  const blast = filter(r, "lowpass", 5600 * p, 0.8);
  blast.frequency.exponentialRampToValueAtTime(320, at + 0.09);
  chain(noise(r, at, 0.13), blast, env(r, at, 0.001, 1.0 * level, 0.11), sat);

  // Thump: the low end you feel in the chest.
  const thump = tone(r, "sine", 175 * p, at, at + 0.2);
  thump.frequency.exponentialRampToValueAtTime(44, at + 0.13);
  chain(thump, env(r, at, 0.003, 1.1 * level, 0.16), sat);

  // Slapback off the facades across the street.
  if (space === "street") {
    const echoes: [delay: number, level: number, cutoff: number][] = [
      [0.115, 0.22, 1400],
      [0.26, 0.11, 700],
    ];
    for (const [delay, g, cutoff] of echoes) {
      const d = r.audio.createDelay(0.5);
      d.delayTime.value = delay + Math.random() * 0.02;
      chain(out, d, filter(r, "lowpass", cutoff), gain(r, g), r.bus);
    }
  }
}

/** Brass casing hitting the pavement: two inharmonic partials, fast decay. */
function casing(r: Rig, at: number): void {
  const out = voice(r, "street", 0.3, 0.14);
  const f = 3600 + Math.random() * 2200;
  chain(tone(r, "sine", f, at, at + 0.14), env(r, at, 0.001, 1, 0.11), out);
  chain(tone(r, "sine", f * 2.41, at, at + 0.08), env(r, at, 0.001, 0.4, 0.05), out);
}

export function gunshot(): void {
  const r = ready();
  if (!r) return;
  shot(r, r.audio.currentTime + 0.01);
}

/** Automatic fire scheduled on the audio clock, with human jitter and level drift. */
export function burst(count: number, interval = 0.09): void {
  const r = ready();
  if (!r) return;
  const now = r.audio.currentTime + 0.01;
  for (let i = 0; i < count; i++) {
    const at = now + i * interval + (i ? (Math.random() - 0.5) * 0.012 : 0);
    shot(r, at, 0.85 + Math.random() * 0.15);
    if (i > 0) casing(r, at + 0.06 + Math.random() * 0.08);
  }
}

/** A revolver across a table: flat, hard, all room slap and no tail. */
export function mutedShot(): void {
  const r = ready();
  if (!r) return;
  const at = r.audio.currentTime + 0.01;
  const out = voice(r, "room", 0.55, 1.2);
  const sat = drive(r, 4);
  sat.connect(out);

  chain(noise(r, at, 0.006), filter(r, "highpass", 1600, 0.6), env(r, at, 0, 0.9, 0.005), sat);

  const body = filter(r, "lowpass", 1800);
  body.frequency.exponentialRampToValueAtTime(220, at + 0.07);
  chain(noise(r, at, 0.09), body, env(r, at, 0.001, 0.8, 0.08), sat);

  const pop = tone(r, "sine", 140, at, at + 0.12);
  pop.frequency.exponentialRampToValueAtTime(50, at + 0.09);
  chain(pop, env(r, at, 0.002, 0.9, 0.1), sat);

  // Hammer back down.
  const click = at + 0.16;
  chain(noise(r, click, 0.004), filter(r, "bandpass", 3200, 3), env(r, click, 0, 0.12, 0.02), out);
}

// ---------------------------------------------------------------------------
// Blasts and breakage

function shatter(r: Rig, at: number, level: number, space: Space): void {
  const out = voice(r, space, 0.3, level * 1.5);

  // Pane gives way.
  chain(noise(r, at, 0.02), filter(r, "bandpass", 2600, 0.9), env(r, at, 0, 0.6, 0.03), out);

  // Shard cluster: narrow noise resonators ring like glass. Front-loaded.
  for (let i = 0; i < 16; i++) {
    const t = at + Math.pow(Math.random(), 1.8) * 0.38;
    const f = 2200 + Math.random() * 6300;
    const dur = 0.04 + Math.random() * 0.18;
    chain(
      noise(r, t, dur + 0.02),
      filter(r, "bandpass", f, 14 + Math.random() * 16),
      env(r, t, 0.001, 0.5 + Math.random() * 0.9, dur),
      out,
    );
  }

  // Late tinkles as pieces settle.
  for (let i = 0; i < 5; i++) {
    const t = at + 0.4 + Math.random() * 0.6;
    chain(
      noise(r, t, 0.1),
      filter(r, "bandpass", 4000 + Math.random() * 4000, 25),
      env(r, t, 0.001, 0.25 + Math.random() * 0.3, 0.09),
      out,
    );
  }
}

export function glass(): void {
  const r = ready();
  if (!r) return;
  shatter(r, r.audio.currentTime + 0.01, 1, "street");
}

export function explosion(): void {
  const r = ready();
  if (!r) return;
  const at = r.audio.currentTime + 0.01;
  const out = voice(r, "street", 0.6, 1);
  const sat = drive(r, 5);
  sat.connect(out);

  // Detonation crack.
  chain(noise(r, at, 0.012), filter(r, "highpass", 900, 0.5), env(r, at, 0, 1.6, 0.01), sat);

  // Boom: pitched sub sweep, distorted for harmonics.
  const boom = tone(r, "sine", 120, at, at + 1.8);
  boom.frequency.exponentialRampToValueAtTime(24, at + 1.1);
  chain(boom, env(r, at, 0.004, 1.5, 1.5), sat);

  // Roar: mid-band pressure that closes down over a second.
  const roar = filter(r, "lowpass", 3200, 0.7);
  roar.frequency.exponentialRampToValueAtTime(140, at + 1.3);
  chain(noise(r, at, 1.4), roar, env(r, at, 0.006, 0.9, 1.2), sat);

  // Rumble: brown noise tail rolling down the block.
  chain(noise(r, at, 2.8, true), filter(r, "lowpass", 160, 0.7), env(r, at, 0.05, 1.2, 2.5), out);

  // Debris coming back down.
  const pieces = 10 + Math.floor(Math.random() * 5);
  for (let i = 0; i < pieces; i++) {
    const t = at + 0.3 + Math.random() * 1.7;
    const g = (0.08 + Math.random() * 0.2) * (1 - (t - at) / 2.4);
    chain(noise(r, t, 0.03), filter(r, "bandpass", 250 + Math.random() * 2400, 2.5), env(r, t, 0.001, g, 0.04), out);
  }

  // Every window on the block.
  shatter(r, at + 0.04, 0.7, "street");
}

/** A fuse that sputters and dies: hiss with random sputter, sparks, a wet cough. */
export function fizzle(): void {
  const r = ready();
  if (!r) return;
  const at = r.audio.currentTime + 0.01;
  const out = voice(r, "street", 0.25, 1);

  const hiss = r.audio.createGain();
  hiss.gain.setValueAtTime(FLOOR, at);
  let level = 0.1;
  for (let t = at; t < at + 1.3; t += 0.04) {
    level = Math.max(0.01, Math.min(0.35, level + (Math.random() - 0.5) * 0.18));
    const fade = 1 - (t - at) / 1.3;
    hiss.gain.linearRampToValueAtTime(level * fade + FLOOR, t + 0.04);
  }
  hiss.gain.linearRampToValueAtTime(FLOOR, at + 1.35);
  chain(noise(r, at, 1.4), filter(r, "highpass", 1800, 0.7), hiss, out);

  for (let i = 0; i < 9; i++) {
    const t = at + Math.random() * 1.2;
    chain(noise(r, t, 0.004), filter(r, "highpass", 3000), env(r, t, 0, 0.25 + Math.random() * 0.25, 0.004), out);
  }

  const cough = at + 1.0;
  const thud = tone(r, "sine", 110, cough, cough + 0.2);
  thud.frequency.exponentialRampToValueAtTime(45, cough + 0.15);
  chain(thud, env(r, cough, 0.004, 0.35, 0.16), out);
  chain(noise(r, cough, 0.08), filter(r, "lowpass", 600), env(r, cough, 0.002, 0.3, 0.07), out);
}

// ---------------------------------------------------------------------------
// Vehicles and police

/**
 * A four-cylinder sedan. Longer cues are a drive-by (winds up, passes, fades);
 * shorter ones pull to the kerb and cut the motor.
 */
export function engine(seconds: number): void {
  const r = ready();
  if (!r) return;
  const at = r.audio.currentTime + 0.01;
  const end = at + seconds;
  const passing = seconds > 1.6;
  const f0 = passing ? 34 : 46;
  const f1 = passing ? 66 : 26;
  const out = voice(r, "street", 0.14, 0.5);

  const rpm = (param: AudioParam, mult: number) => {
    param.setValueAtTime(f0 * mult, at);
    param.exponentialRampToValueAtTime(f1 * mult, at + seconds * 0.75);
    if (passing) param.exponentialRampToValueAtTime(f1 * 0.92 * mult, end);
  };

  const amp = passing
    ? contour(r, [[at, 0.35], [at + seconds * 0.55, 1], [end, 0.25]])
    : contour(r, [[at, FLOOR], [at + 0.25, 1], [end - 0.35, 0.9], [end, FLOOR]]);
  amp.connect(out);

  // Firing pulses: saw + half-speed sub for the uneven four-banger chug.
  const saw = tone(r, "sawtooth", f0, at, end);
  rpm(saw.frequency, 1);
  const sub = tone(r, "sine", f0 / 2, at, end);
  rpm(sub.frequency, 0.5);
  const chug = drive(r, 6);
  saw.connect(chug);
  chain(sub, gain(r, 0.7), chug);
  chain(chug, filter(r, "lowpass", 380, 0.8), gain(r, 0.5), amp);

  // Exhaust puffs: noise amplitude-modulated at the firing rate.
  const am = gain(r, 0.5);
  const mod = tone(r, "sine", f0, at, end);
  rpm(mod.frequency, 1);
  const depth = gain(r, 0.5);
  mod.connect(depth);
  depth.connect(am.gain);
  chain(noise(r, at, seconds), filter(r, "lowpass", 700), am, gain(r, 0.22), amp);

  // Valve train tick.
  const tick = tone(r, "square", f0 * 2, at, end);
  rpm(tick.frequency, 2);
  chain(tick, filter(r, "highpass", 1500), gain(r, 0.03), amp);

  // Tyres on the road.
  const road = gain(r, passing ? 0.06 : 0.04);
  chain(noise(r, at, seconds), filter(r, "bandpass", 1100, 0.6), road, amp);
}

/** Mechanical wail, two cars slightly out of step, opening up as they close in. */
export function siren(seconds: number): void {
  const r = ready();
  if (!r) return;
  const at = r.audio.currentTime + 0.01;
  const end = at + seconds;
  const out = voice(r, "street", 0.45, 1);
  const cars: [detune: number, delay: number, level: number][] = [
    [1, 0, 1],
    [1.028, 0.35, 0.55],
  ];
  const partials: [OscillatorType, number, number][] = [
    ["sine", 1, 1],
    ["triangle", 2, 0.35],
    ["sawtooth", 1, 0.12],
    ["sine", 3, 0.15],
  ];
  const lfo = tone(r, "sine", 5.5, at, end);
  const vibrato = gain(r, 6);
  lfo.connect(vibrato);

  for (const [detune, delay, level] of cars) {
    const start = at + delay;
    if (start >= end) continue;
    const lp = filter(r, "lowpass", 900, 0.8);
    lp.frequency.exponentialRampToValueAtTime(3200, start + seconds * 0.6);
    const amp = contour(r, [[start, FLOOR], [start + 0.5, level * 0.09], [end - 0.5, level * 0.09], [end, FLOOR]]);
    chain(lp, amp, out);

    for (const [type, mult, g] of partials) {
      const o = tone(r, type, 390 * mult * detune, start, end);
      vibrato.connect(o.detune);
      let t = start;
      let up = true;
      o.frequency.setValueAtTime(390 * mult * detune, start);
      while (t < end) {
        const leg = up ? 0.9 : 1.3;
        t = Math.min(t + leg, end);
        o.frequency.exponentialRampToValueAtTime((up ? 860 : 390) * mult * detune, t);
        up = !up;
      }
      chain(o, gain(r, g), lp);
    }
  }
}

// ---------------------------------------------------------------------------
// Foley

/** Leather soles on pavement: heel click, sole thud, a little scuff. */
export function footsteps(count: number, interval = 0.44): void {
  const r = ready();
  if (!r) return;
  const out = voice(r, "street", 0.22, 1);
  let t = r.audio.currentTime + 0.06;
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 0.94 : 1;
    chain(noise(r, t, 0.012), filter(r, "bandpass", 2100 * side, 1.3), env(r, t, 0, 0.5, 0.014), out);
    const sole = tone(r, "sine", 110 * side, t, t + 0.08);
    sole.frequency.exponentialRampToValueAtTime(58, t + 0.06);
    chain(sole, env(r, t, 0.002, 0.35, 0.07), out);
    const scuff = t + 0.02;
    chain(noise(r, scuff, 0.06), filter(r, "highpass", 3200), env(r, scuff, 0.01, 0.05, 0.05), out);
    t += interval * (0.94 + Math.random() * 0.12);
  }
}

/** Sheet metal meeting something solid. */
export function crash(): void {
  const r = ready();
  if (!r) return;
  const at = r.audio.currentTime + 0.01;
  const out = voice(r, "street", 0.4, 1);
  const sat = drive(r, 3);
  sat.connect(out);
  chain(noise(r, at, 0.05), filter(r, "lowpass", 1200), env(r, at, 0, 1.2, 0.08), sat);
  const thud = tone(r, "sine", 90, at, at + 0.3);
  thud.frequency.exponentialRampToValueAtTime(35, at + 0.2);
  chain(thud, env(r, at, 0.003, 1, 0.25), sat);
  for (let i = 0; i < 6; i++) {
    const t = at + Math.random() * 0.12;
    chain(noise(r, t, 0.4), filter(r, "bandpass", 500 + Math.random() * 1400, 12), env(r, t, 0.002, 0.5, 0.35), out);
  }
  shatter(r, at + 0.03, 0.6, "street");
}

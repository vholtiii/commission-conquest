import { useGameStore } from "@/engine/store";
import { sharedAudio } from "./sfx";

/**
 * Distant city, heard from the map. A quiet low rumble runs underneath, and
 * now and then a horn, a train, or a bell comes from a few blocks away.
 * Events go through a dark distance reverb. The rumble stays dry. Its own
 * gain, so a cinematic mute leaves the volume slider in charge.
 */

type Kind = "horn" | "train" | "dog" | "tram" | "bell" | "siren";

let out: GainNode | null = null;
let duck: GainNode | null = null;
let distance: ConvolverNode | null = null;
let volume = 0.4;
let running = false;
let eventTimer: ReturnType<typeof setTimeout> | null = null;
let lastKind: Kind | null = null;
let white: AudioBuffer | null = null;
let brown: AudioBuffer | null = null;

const FLOOR = 0.0001;

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function noise(audio: AudioContext, brownish: boolean): AudioBuffer {
  if (brownish && brown) return brown;
  if (!brownish && white) return white;
  const length = Math.floor(audio.sampleRate * 2);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  let acc = 0;
  for (let i = 0; i < length; i++) {
    const w = Math.random() * 2 - 1;
    if (brownish) {
      acc = (acc + 0.02 * w) / 1.02;
      data[i] = acc * 3.5;
    } else {
      data[i] = w;
    }
  }
  if (brownish) brown = buffer;
  else white = buffer;
  return buffer;
}

/** A long, dark tail. Normalized off, or the wet send would shout. */
function distanceImpulse(audio: AudioContext): AudioBuffer {
  const seconds = 2.5;
  const rate = audio.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = audio.createBuffer(2, length, rate);
  const tone = 1 - Math.exp((-2 * Math.PI * 2000) / rate);
  const decay = 6.9 / seconds;
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const s = (Math.random() * 2 - 1) * Math.exp(-decay * t);
      lp += (s - lp) * tone;
      data[i] = lp * 0.18;
    }
  }
  return buffer;
}

/**
 * Pan, a dull low-pass for distance, and a wet send into the city reverb.
 * Returns the node an event connects into.
 */
function place(opts: { pan: number; panTo?: number; seconds: number; farHz: number; wet: number }): StereoPannerNode | null {
  const audio = sharedAudio();
  if (!audio || !duck || !distance) return null;
  const at = audio.currentTime;
  const panner = audio.createStereoPanner();
  panner.pan.setValueAtTime(Math.max(-1, Math.min(1, opts.pan)), at);
  if (opts.panTo !== undefined) {
    panner.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, opts.panTo)), at + opts.seconds);
  }
  const far = audio.createBiquadFilter();
  far.type = "lowpass";
  far.frequency.value = opts.farHz;
  const wet = audio.createGain();
  wet.gain.value = opts.wet;
  panner.connect(far).connect(duck);
  panner.connect(wet).connect(distance);
  return panner;
}

function envGain(audio: AudioContext, at: number, peak: number, attack: number, dur: number): GainNode {
  const gain = audio.createGain();
  const release = Math.min(0.12, dur * 0.35);
  gain.gain.setValueAtTime(FLOOR, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  if (dur - release > attack) gain.gain.setValueAtTime(peak, at + dur - release);
  gain.gain.exponentialRampToValueAtTime(FLOOR, at + dur);
  return gain;
}

/** One 1920s bulb horn: two notes a third apart, soft attack, a narrow band. */
function honk(at: number, freq: number, dur: number, pan: number, level: number): void {
  const audio = sharedAudio();
  const dest = place({ pan, seconds: dur, farHz: rand(1400, 2000), wet: rand(0.28, 0.45) });
  if (!audio || !dest) return;
  const band = audio.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = rand(440, 560);
  band.Q.value = rand(1.1, 1.8);
  const gain = envGain(audio, at, level, 0.045, dur);
  const third = freq * (Math.random() < 0.5 ? 1.189 : 1.26);
  for (const f of [freq, third * rand(0.995, 1.006)]) {
    const osc = audio.createOscillator();
    osc.type = Math.random() < 0.5 ? "square" : "sawtooth";
    osc.frequency.value = f;
    osc.connect(band);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }
  band.connect(gain).connect(dest);
}

function horn(): void {
  const audio = sharedAudio();
  if (!audio) return;
  const at = audio.currentTime + 0.05;
  const freq = rand(340, 520);
  const pan = rand(-0.65, 0.65);
  const pattern = Math.floor(Math.random() * 3);
  if (pattern === 0) {
    honk(at, freq, rand(0.55, 0.95), pan, rand(0.07, 0.1));
  } else if (pattern === 1) {
    const d = rand(0.14, 0.22);
    const gap = rand(0.12, 0.24);
    honk(at, freq, d, pan, 0.09);
    honk(at + d + gap, freq * rand(0.98, 1.02), d, pan + rand(-0.05, 0.05), 0.085);
  } else {
    honk(at, freq, rand(0.28, 0.45), pan, 0.09);
    honk(at + rand(0.5, 0.85), freq * rand(0.82, 1.18), rand(0.3, 0.6), rand(-0.75, 0.75), rand(0.05, 0.08));
  }
}

/** Wheels on the el: a rumble that passes, and pairs of clacks that speed up then slow. */
function elTrain(): void {
  const audio = sharedAudio();
  if (!audio) return;
  const at = audio.currentTime + 0.05;
  const dur = rand(5.4, 6.8);
  const from = Math.random() < 0.5 ? rand(-0.9, -0.55) : rand(0.55, 0.9);
  const dest = place({ pan: from, panTo: -from, seconds: dur, farHz: rand(700, 1100), wet: rand(0.4, 0.6) });
  if (!dest) return;

  const rumble = audio.createBufferSource();
  rumble.buffer = noise(audio, true);
  rumble.loop = true;
  const body = audio.createBiquadFilter();
  body.type = "lowpass";
  body.frequency.setValueAtTime(rand(70, 100), at);
  body.frequency.linearRampToValueAtTime(rand(170, 230), at + dur * 0.45);
  body.frequency.linearRampToValueAtTime(rand(60, 90), at + dur);
  const rumbleGain = audio.createGain();
  const peak = rand(0.1, 0.15);
  rumbleGain.gain.setValueAtTime(FLOOR, at);
  rumbleGain.gain.linearRampToValueAtTime(peak, at + dur * 0.4);
  rumbleGain.gain.linearRampToValueAtTime(FLOOR, at + dur);
  rumble.connect(body).connect(rumbleGain).connect(dest);
  rumble.start(at);
  rumble.stop(at + dur + 0.05);

  const clacks = audio.createGain();
  clacks.gain.value = rand(0.35, 0.55);
  const bright = audio.createBiquadFilter();
  bright.type = "highpass";
  bright.frequency.setValueAtTime(rand(400, 600), at);
  bright.frequency.linearRampToValueAtTime(rand(1200, 1700), at + dur * 0.45);
  bright.frequency.linearRampToValueAtTime(rand(350, 550), at + dur);
  clacks.connect(bright).connect(dest);

  const tickBuf = noise(audio, false);
  let t = 0.2;
  while (t < dur - 0.3) {
    const along = t / dur;
    const speed = Math.max(0, 1 - Math.abs(along - 0.45) * 2.2);
    for (const offset of [0, rand(0.022, 0.034)]) {
      const when = at + t + offset;
      const src = audio.createBufferSource();
      src.buffer = tickBuf;
      src.playbackRate.value = rand(0.75, 1.45);
      const click = audio.createGain();
      click.gain.setValueAtTime(rand(0.25, 0.55), when);
      click.gain.exponentialRampToValueAtTime(FLOOR, when + 0.028);
      const metal = audio.createBiquadFilter();
      metal.type = "bandpass";
      metal.frequency.value = rand(800, 1800);
      metal.Q.value = rand(1.5, 3);
      src.connect(metal).connect(click).connect(clacks);
      src.start(when);
      src.stop(when + 0.04);
    }
    t += 0.17 - speed * 0.1;
  }
}

/** A hand-cranked wail several blocks off: one rise, a slow fall, a little wobble. */
function farSiren(): void {
  const audio = sharedAudio();
  if (!audio) return;
  const at = audio.currentTime + 0.05;
  const dur = rand(4.2, 5.6);
  const dest = place({ pan: rand(-0.35, 0.35), seconds: dur, farHz: rand(520, 720), wet: rand(0.75, 0.95) });
  if (!dest) return;

  const base = rand(400, 560);
  const osc = audio.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(base, at);
  osc.frequency.linearRampToValueAtTime(base * rand(1.55, 1.9), at + rand(1.3, 1.7));
  osc.frequency.exponentialRampToValueAtTime(base * rand(0.75, 0.95), at + dur);

  const wobble = audio.createOscillator();
  wobble.frequency.value = rand(4.5, 6.5);
  const depth = audio.createGain();
  depth.gain.value = rand(6, 14);
  wobble.connect(depth).connect(osc.frequency);
  wobble.start(at);
  wobble.stop(at + dur + 0.1);

  const dull = audio.createBiquadFilter();
  dull.type = "lowpass";
  dull.frequency.value = rand(800, 1100);
  const gain = envGain(audio, at, rand(0.018, 0.028), 0.35, dur);
  osc.connect(dull).connect(gain).connect(dest);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

const BELL_RATIOS = [1, 2, 2.4, 3, 4.2];
const BELL_LEVELS = [1, 0.42, 0.28, 0.16, 0.09];

function bellStroke(at: number, fund: number, dest: AudioNode, scale: number): void {
  const audio = sharedAudio();
  if (!audio) return;
  BELL_RATIOS.forEach((ratio, i) => {
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = fund * ratio * rand(0.997, 1.003);
    const partial = audio.createGain();
    const peak = BELL_LEVELS[i] * scale;
    const decay = rand(1.6, 2.6) - i * 0.32;
    partial.gain.setValueAtTime(FLOOR, at);
    partial.gain.exponentialRampToValueAtTime(peak, at + 0.008);
    partial.gain.exponentialRampToValueAtTime(FLOOR, at + Math.max(0.2, decay));
    osc.connect(partial).connect(dest);
    osc.start(at);
    osc.stop(at + decay + 0.05);
  });
  const strike = audio.createBufferSource();
  strike.buffer = noise(audio, false);
  const click = audio.createGain();
  click.gain.setValueAtTime(scale * 0.4, at);
  click.gain.exponentialRampToValueAtTime(FLOOR, at + 0.02);
  const metal = audio.createBiquadFilter();
  metal.type = "highpass";
  metal.frequency.value = fund * 3;
  strike.connect(metal).connect(click).connect(dest);
  strike.start(at);
  strike.stop(at + 0.03);
}

function bell(): void {
  const audio = sharedAudio();
  if (!audio) return;
  const at = audio.currentTime + 0.05;
  const strokes = 2 + Math.floor(Math.random() * 2);
  const fund = rand(190, 460);
  const gap = rand(0.9, 1.45);
  const dur = gap * strokes + 2.4;
  const dest = place({ pan: rand(-0.45, 0.45), seconds: dur, farHz: rand(1400, 1900), wet: rand(0.45, 0.65) });
  if (!dest) return;
  for (let i = 0; i < strokes; i++) {
    bellStroke(at + i * gap * rand(0.96, 1.04), fund * rand(0.998, 1.002), dest, rand(0.07, 0.1));
  }
}

function barkOnce(at: number, dest: AudioNode): void {
  const audio = sharedAudio();
  if (!audio) return;
  const dur = rand(0.08, 0.16);
  const env = envGain(audio, at, rand(0.14, 0.2), 0.012, dur);

  const body = audio.createOscillator();
  body.type = "sawtooth";
  const f0 = rand(420, 720);
  body.frequency.setValueAtTime(f0, at);
  body.frequency.exponentialRampToValueAtTime(Math.max(80, f0 * rand(0.5, 0.7)), at + dur);
  const formant = audio.createBiquadFilter();
  formant.type = "bandpass";
  formant.frequency.value = rand(620, 1000);
  formant.Q.value = rand(3, 5);
  body.connect(formant).connect(env);
  body.start(at);
  body.stop(at + dur + 0.02);

  const air = audio.createBufferSource();
  air.buffer = noise(audio, false);
  air.loop = true;
  const hiss = audio.createGain();
  hiss.gain.setValueAtTime(FLOOR, at);
  hiss.gain.exponentialRampToValueAtTime(rand(0.07, 0.11), at + 0.01);
  hiss.gain.exponentialRampToValueAtTime(FLOOR, at + dur * 0.75);
  const upper = audio.createBiquadFilter();
  upper.type = "bandpass";
  upper.frequency.value = rand(1300, 1900);
  upper.Q.value = rand(2, 4);
  air.connect(upper).connect(hiss);
  hiss.connect(env);
  air.start(at);
  air.stop(at + dur);
  env.connect(dest);
}

function dog(): void {
  const audio = sharedAudio();
  if (!audio) return;
  const at = audio.currentTime + 0.05;
  const count = 2 + Math.floor(Math.random() * 2);
  const dest = place({ pan: rand(-0.7, 0.7), seconds: 1.2, farHz: rand(1200, 1700), wet: rand(0.3, 0.5) });
  if (!dest) return;
  let t = at;
  for (let i = 0; i < count; i++) {
    barkOnce(t, dest);
    t += rand(0.16, 0.38);
  }
}

/** Two quick high pings, closer than the church bell. */
function tram(): void {
  const audio = sharedAudio();
  if (!audio) return;
  const at = audio.currentTime + 0.05;
  const fund = rand(880, 1350);
  const gap = rand(0.11, 0.2);
  const dest = place({ pan: rand(-0.55, 0.55), seconds: 0.8, farHz: rand(2000, 2800), wet: rand(0.18, 0.32) });
  if (!dest) return;
  const ratios = [1, 2.01, 2.76, 3.95];
  for (let n = 0; n < 2; n++) {
    const when = at + n * gap;
    ratios.forEach((ratio, i) => {
      const osc = audio.createOscillator();
      osc.type = "sine";
      osc.frequency.value = fund * ratio * rand(0.998, 1.002);
      const partial = audio.createGain();
      const decay = rand(0.28, 0.5) - i * 0.06;
      partial.gain.setValueAtTime(FLOOR, when);
      partial.gain.exponentialRampToValueAtTime((0.09 - i * 0.018) * rand(0.85, 1.1), when + 0.004);
      partial.gain.exponentialRampToValueAtTime(FLOOR, when + Math.max(0.08, decay));
      osc.connect(partial).connect(dest);
      osc.start(when);
      osc.stop(when + decay + 0.04);
    });
  }
}

function weights(): { kind: Kind; w: number }[] {
  const month = useGameStore.getState().date?.month ?? 6;
  const winter = month === 12 || month <= 2;
  return [
    { kind: "horn", w: 40 },
    { kind: "train", w: 18 },
    { kind: "dog", w: winter ? 4 : 14 },
    { kind: "tram", w: 12 },
    { kind: "bell", w: 8 },
    { kind: "siren", w: 5 },
  ];
}

function pickKind(): Kind {
  const options = weights().filter((o) => o.kind !== lastKind);
  const total = options.reduce((sum, o) => sum + o.w, 0);
  let roll = Math.random() * total;
  for (const option of options) {
    roll -= option.w;
    if (roll <= 0) return option.kind;
  }
  return options[options.length - 1].kind;
}

const PLAY: Record<Kind, () => void> = {
  horn,
  train: elTrain,
  dog,
  tram,
  bell,
  siren: farSiren,
};

/** Far traffic: two brown loops that don't line up, nothing above a few hundred hertz. */
function startBed(audio: AudioContext): void {
  if (!duck) return;
  const at = audio.currentTime;
  const level = rand(0.05, 0.07);
  const mix = audio.createGain();
  mix.gain.value = 1;

  const lengths = [11, 17];
  const cutoffs = [220, rand(180, 260)];
  lengths.forEach((seconds, i) => {
    const src = audio.createBufferSource();
    src.buffer = brownLoop(audio, seconds);
    src.loop = true;
    const low = audio.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = cutoffs[i];
    src.connect(low).connect(mix);
    src.start(at);
    if (i === 0) {
      const sweep = audio.createOscillator();
      sweep.frequency.value = rand(0.03, 0.05);
      const depth = audio.createGain();
      depth.gain.value = 40;
      sweep.connect(depth).connect(low.frequency);
      sweep.start(at);
    }
  });

  const body = audio.createBiquadFilter();
  body.type = "highpass";
  body.frequency.value = 35;
  body.Q.value = 0.7;
  const bed = audio.createGain();
  bed.gain.setValueAtTime(0, at);
  bed.gain.linearRampToValueAtTime(level, at + 4);
  const drift = audio.createOscillator();
  drift.frequency.value = rand(0.02, 0.035);
  const driftDepth = audio.createGain();
  driftDepth.gain.value = level * 0.2;
  drift.connect(driftDepth).connect(bed.gain);
  drift.start(at + 4);
  mix.connect(body).connect(bed).connect(duck);
}

function brownLoop(audio: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(audio.sampleRate * seconds);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  let acc = 0;
  for (let i = 0; i < length; i++) {
    acc = (acc + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = acc * 3.5;
  }
  return buffer;
}

function scheduleNext(): void {
  if (eventTimer) clearTimeout(eventTimer);
  const wait = 8_000 + Math.random() * 12_000;
  eventTimer = setTimeout(() => {
    const kind = pickKind();
    lastKind = kind;
    PLAY[kind]();
    scheduleNext();
  }, wait);
}

export function startAmbience(): void {
  if (running) return;
  const audio = sharedAudio();
  if (!audio) return;
  running = true;
  out = audio.createGain();
  out.gain.value = volume;
  duck = audio.createGain();
  duck.gain.value = 1;
  duck.connect(out).connect(audio.destination);

  distance = audio.createConvolver();
  distance.normalize = false;
  distance.buffer = distanceImpulse(audio);
  distance.connect(duck);

  startBed(audio);
  scheduleNext();
}

export function setAmbienceVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (out) out.gain.value = volume;
}

/** Pull the city down while a hit or a sit-down plays. */
export function duckAmbience(on: boolean): void {
  const audio = sharedAudio();
  if (!audio || !duck) return;
  duck.gain.cancelScheduledValues(audio.currentTime);
  duck.gain.linearRampToValueAtTime(on ? 0.2 : 1, audio.currentTime + 0.35);
}

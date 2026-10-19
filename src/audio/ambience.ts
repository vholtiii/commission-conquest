import { useGameStore } from "@/engine/store";
import { sharedAudio } from "./sfx";

let out: GainNode | null = null;
let duck: GainNode | null = null;
let rainGain: GainNode | null = null;
let windGain: GainNode | null = null;
let volume = 0.4;
let running = false;
let hornTimer: ReturnType<typeof setTimeout> | null = null;

function seasonMix(): { rain: number; wind: number } {
  const month = useGameStore.getState().date?.month ?? 6;
  const winter = month === 12 || month <= 2;
  const autumn = month >= 9 && month <= 11;
  if (winter) return { rain: 0.2, wind: 0.1 };
  if (autumn) return { rain: 0.3, wind: 0.04 };
  return { rain: 0.1, wind: 0.015 };
}

function applySeason(): void {
  const mix = seasonMix();
  if (rainGain) rainGain.gain.value = mix.rain;
  if (windGain) windGain.gain.value = mix.wind;
}

function noiseBuffer(audio: AudioContext, seconds: number, brown: boolean): AudioBuffer {
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

function loop(audio: AudioContext, buffer: AudioBuffer, destination: AudioNode): AudioBufferSourceNode {
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(destination);
  source.start();
  return source;
}

function scheduleHorn() {
  const wait = 20_000 + Math.random() * 40_000;
  hornTimer = setTimeout(() => {
    applySeason();
    horn();
    scheduleHorn();
  }, wait);
}

function scheduleEl() {
  const wait = 70_000 + Math.random() * 50_000;
  setTimeout(() => {
    elTrain();
    scheduleEl();
  }, wait);
}

function scheduleFarSiren() {
  const wait = 150_000 + Math.random() * 90_000;
  setTimeout(() => {
    farSiren();
    scheduleFarSiren();
  }, wait);
}

function horn() {
  const audio = sharedAudio();
  if (!audio || !duck) return;
  const at = audio.currentTime + 0.05;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.12, at + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
  gain.connect(duck);
  for (const [freq, start] of [
    [310, at],
    [370, at + 0.28],
  ] as const) {
    const osc = audio.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    const band = audio.createBiquadFilter();
    band.type = "lowpass";
    band.frequency.value = 900;
    osc.connect(band).connect(gain);
    osc.start(start);
    osc.stop(start + 0.22);
  }
}

/** A train on the el, a long way off. */
function elTrain(): void {
  const audio = sharedAudio();
  if (!audio || !duck) return;
  const at = audio.currentTime + 0.05;
  const src = audio.createBufferSource();
  src.buffer = noiseBuffer(audio, 4, true);
  src.loop = true;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(0.07, at + 1.2);
  gain.gain.linearRampToValueAtTime(0.0001, at + 4.2);
  const band = audio.createBiquadFilter();
  band.type = "lowpass";
  band.frequency.setValueAtTime(90, at);
  band.frequency.linearRampToValueAtTime(180, at + 1.4);
  band.frequency.linearRampToValueAtTime(70, at + 4);
  src.connect(band).connect(gain).connect(duck);
  src.start(at);
  src.stop(at + 4.4);
}

/** A siren several blocks away, not the one that arrives on a botched hit. */
function farSiren(): void {
  const audio = sharedAudio();
  if (!audio || !duck) return;
  const at = audio.currentTime + 0.05;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(0.035, at + 0.6);
  gain.gain.linearRampToValueAtTime(0.0001, at + 4.5);
  const far = audio.createBiquadFilter();
  far.type = "lowpass";
  far.frequency.value = 700;
  gain.connect(far).connect(duck);
  const osc = audio.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(540, at);
  osc.frequency.linearRampToValueAtTime(760, at + 0.7);
  osc.frequency.linearRampToValueAtTime(520, at + 1.4);
  osc.frequency.linearRampToValueAtTime(740, at + 2.2);
  osc.frequency.linearRampToValueAtTime(500, at + 3.2);
  osc.connect(gain);
  osc.start(at);
  osc.stop(at + 4.6);
}

/** Rain, wind, traffic, a horn, a train, a far siren. Its own gain, so a cinematic mute leaves it up. */
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

  rainGain = audio.createGain();
  rainGain.gain.value = seasonMix().rain;
  const rainFilter = audio.createBiquadFilter();
  rainFilter.type = "bandpass";
  rainFilter.frequency.value = 1400;
  rainFilter.Q.value = 0.6;
  loop(audio, noiseBuffer(audio, 4, false), rainFilter);
  rainFilter.connect(rainGain).connect(duck);
  const drift = audio.createOscillator();
  drift.frequency.value = 0.07;
  const driftGain = audio.createGain();
  driftGain.gain.value = 0.06;
  drift.connect(driftGain).connect(rainGain.gain);
  drift.start();

  const traffic = audio.createGain();
  traffic.gain.value = 0.22;
  const rumble = audio.createBiquadFilter();
  rumble.type = "lowpass";
  rumble.frequency.value = 160;
  loop(audio, noiseBuffer(audio, 4, true), rumble);
  rumble.connect(traffic).connect(duck);

  windGain = audio.createGain();
  windGain.gain.value = seasonMix().wind;
  const windFilter = audio.createBiquadFilter();
  windFilter.type = "highpass";
  windFilter.frequency.value = 800;
  loop(audio, noiseBuffer(audio, 4, false), windFilter);
  windFilter.connect(windGain).connect(duck);

  scheduleHorn();
  scheduleEl();
  scheduleFarSiren();
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

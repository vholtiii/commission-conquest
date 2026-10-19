import { sharedAudio } from "./sfx";

let out: GainNode | null = null;
let duck: GainNode | null = null;
let volume = 0.4;
let running = false;
let hornTimer: ReturnType<typeof setTimeout> | null = null;

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
    horn();
    scheduleHorn();
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

/** Rain, traffic, and the odd horn. Its own gain, so a cinematic mute leaves it up. */
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

  const rainGain = audio.createGain();
  rainGain.gain.value = 0.18;
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

  scheduleHorn();
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

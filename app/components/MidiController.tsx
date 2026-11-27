import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Sun,
  Moon,
  Volume2,
  VolumeX,
  Piano as PianoIcon,
  AudioWaveform,
  RotateCcw,
  Keyboard,
  Usb,
  Sparkles,
  Square,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
} from "lucide-react";
import Piano from "./Piano";
import ControlKnob from "./ControlKnob";
import { PianoSynthesizer, type PianoNoteNodes } from "./PianoSynthesizer";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";

interface AudioSettings {
  volume: number;
  attack: number;
  release: number;
  filterFreq: number;
  reverb: number;
}

type SoundMode = "piano" | "oscillator";
type ThemeMode = "light" | "dark";

const DEFAULT_SETTINGS: AudioSettings = {
  volume: 0.72,
  attack: 0.015,
  release: 1.4,
  filterFreq: 4200,
  reverb: 0.25,
};

const MIDI_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function midiNumberToNote(midi: number) {
  const octave = Math.floor(midi / 12) - 1;
  const name = MIDI_NOTE_NAMES[midi % 12];
  const frequency = 440 * Math.pow(2, (midi - 69) / 12);
  return { note: `${name}${octave}`, frequency };
}

const MidiController: React.FC = () => {
  // Light / Dark theme synced with <html> class & localStorage
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof document !== "undefined") {
      return document.documentElement.classList.contains("dark") ? "dark" : "light";
    }
    return "light";
  });

  const [audioReady, setAudioReady] = useState(false);
  const [soundMode, setSoundMode] = useState<SoundMode>("piano");
  const [waveform, setWaveform] = useState<OscillatorType>("triangle");
  const [octaveOffset, setOctaveOffset] = useState(0);
  const [sustainOn, setSustainOn] = useState(false);
  const [showKeyLabels, setShowKeyLabels] = useState(true);
  const [deviceKeyboardOpen, setDeviceKeyboardOpen] = useState(false);
  const [activeNoteList, setActiveNoteList] = useState<string[]>([]);
  const [midiDeviceName, setMidiDeviceName] = useState<string | null>(null);
  const [midiActiveNotes, setMidiActiveNotes] = useState<Set<string>>(new Set());

  const [audioSettings, setAudioSettings] = useState<AudioSettings>(DEFAULT_SETTINGS);

  // Refs for real-time audio graph without stale closures
  const audioContextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const filterRef = useRef<BiquadFilterNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const pianoSynthRef = useRef<PianoSynthesizer | null>(null);

  const activeOscillatorsRef = useRef<Map<string, { osc: OscillatorNode; gain: GainNode }>>(
    new Map(),
  );
  const activePianoNotesRef = useRef<Map<string, PianoNoteNodes>>(new Map());
  const sustainedNotesRef = useRef<Set<string>>(new Set());

  const settingsRef = useRef(audioSettings);
  settingsRef.current = audioSettings;
  const soundModeRef = useRef(soundMode);
  soundModeRef.current = soundMode;
  const waveformRef = useRef(waveform);
  waveformRef.current = waveform;
  const sustainRef = useRef(sustainOn);
  sustainRef.current = sustainOn;

  // Apply theme class & update meta theme-color
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem("midi-studio-theme", theme);
    } catch {
      // Ignore storage restrictions
    }
  }, [theme]);

  // Dynamic SEO document title reflecting current studio mode
  useEffect(() => {
    const modeLabel =
      soundMode === "piano"
        ? "3D Piano Mode"
        : `${waveform.charAt(0).toUpperCase() + waveform.slice(1)} Synth Mode`;
    document.title = `MIDI Controller Studio — ${modeLabel} | Online 3D Piano & Synthesizer`;
  }, [soundMode, waveform]);

  const createReverbImpulse = (ctx: AudioContext, duration = 2.1, decay = 2.4) => {
    const length = Math.floor(ctx.sampleRate * duration);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const channelData = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  };

  // Lazy + safe Web Audio graph initialization with real wet/dry reverb & compressor limiter
  const ensureAudioGraph = useCallback((): AudioContext | null => {
    if (audioContextRef.current) {
      if (audioContextRef.current.state === "suspended") {
        audioContextRef.current
          .resume()
          .then(() => setAudioReady(true))
          .catch(() => {});
      } else if (audioContextRef.current.state === "running") {
        setAudioReady(true);
      }
      return audioContextRef.current;
    }

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();

      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(settingsRef.current.volume, ctx.currentTime);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(settingsRef.current.filterFreq, ctx.currentTime);
      filter.Q.setValueAtTime(1.1, ctx.currentTime);

      const dryGain = ctx.createGain();
      const wetGain = ctx.createGain();
      const mix = settingsRef.current.reverb;
      dryGain.gain.setValueAtTime(1 - mix * 0.45, ctx.currentTime);
      wetGain.gain.setValueAtTime(mix * 0.9, ctx.currentTime);

      const reverb = ctx.createConvolver();
      reverb.buffer = createReverbImpulse(ctx, 2.1, 2.4);

      // Gentle master limiter prevents clipping on rich chords
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-10, ctx.currentTime);
      compressor.knee.setValueAtTime(18, ctx.currentTime);
      compressor.ratio.setValueAtTime(6, ctx.currentTime);
      compressor.attack.setValueAtTime(0.005, ctx.currentTime);
      compressor.release.setValueAtTime(0.15, ctx.currentTime);

      // Audio signal chain: Notes -> MasterGain -> Filter -> [Dry + Wet Reverb] -> Limiter -> Output
      masterGain.connect(filter);
      filter.connect(dryGain);
      filter.connect(reverb);
      reverb.connect(wetGain);
      dryGain.connect(compressor);
      wetGain.connect(compressor);
      compressor.connect(ctx.destination);

      audioContextRef.current = ctx;
      masterGainRef.current = masterGain;
      filterRef.current = filter;
      dryGainRef.current = dryGain;
      wetGainRef.current = wetGain;
      pianoSynthRef.current = new PianoSynthesizer(ctx, masterGain);

      if (ctx.state === "suspended") {
        ctx
          .resume()
          .then(() => setAudioReady(true))
          .catch(() => {});
      } else {
        setAudioReady(true);
      }

      return ctx;
    } catch (error) {
      console.error("Failed to initialize Web Audio:", error);
      return null;
    }
  }, []);

  const syncActiveDisplay = useCallback(() => {
    const names = new Set<string>([
      ...activePianoNotesRef.current.keys(),
      ...activeOscillatorsRef.current.keys(),
    ]);
    setActiveNoteList(Array.from(names));
  }, []);

  const releaseSingleNote = useCallback(
    (note: string, immediate = false) => {
      const ctx = audioContextRef.current;

      const pianoNode = activePianoNotesRef.current.get(note);
      if (pianoNode && pianoSynthRef.current) {
        pianoSynthRef.current.updateSettings({
          volume: settingsRef.current.volume,
          attack: settingsRef.current.attack,
          release: settingsRef.current.release,
        });
        pianoSynthRef.current.stopPianoSound(pianoNode, immediate);
        activePianoNotesRef.current.delete(note);
      }

      const oscNode = activeOscillatorsRef.current.get(note);
      if (oscNode && ctx) {
        try {
          const now = ctx.currentTime;
          const rel = immediate ? 0.03 : Math.max(0.02, Math.min(settingsRef.current.release, 3.0));
          const curr = Math.max(0.0001, oscNode.gain.gain.value);
          oscNode.gain.gain.cancelScheduledValues(now);
          oscNode.gain.gain.setValueAtTime(curr, now);
          oscNode.gain.gain.exponentialRampToValueAtTime(0.0001, now + rel);
          oscNode.osc.stop(now + rel + 0.04);
          window.setTimeout(() => {
            try {
              oscNode.osc.disconnect();
              oscNode.gain.disconnect();
            } catch {
              // Ignore
            }
          }, (rel + 0.12) * 1000);
        } catch {
          // Ignore stop errors
        } finally {
          activeOscillatorsRef.current.delete(note);
        }
      }

      sustainedNotesRef.current.delete(note);
      syncActiveDisplay();
    },
    [syncActiveDisplay],
  );

  const stopAllNotes = useCallback(
    (immediate = false) => {
      const allActive = new Set<string>([
        ...activePianoNotesRef.current.keys(),
        ...activeOscillatorsRef.current.keys(),
      ]);
      allActive.forEach((n) => releaseSingleNote(n, immediate));
      sustainedNotesRef.current.clear();
      setMidiActiveNotes(new Set());
      setActiveNoteList([]);
    },
    [releaseSingleNote],
  );

  const playNote = useCallback(
    (frequency: number, note: string, velocity = 0.85) => {
      const ctx = ensureAudioGraph();
      if (!ctx || !masterGainRef.current) return;

      // Retrigger cleanly if already active
      if (activePianoNotesRef.current.has(note) || activeOscillatorsRef.current.has(note)) {
        releaseSingleNote(note, true);
      }
      sustainedNotesRef.current.delete(note);

      const currSettings = settingsRef.current;

      if (soundModeRef.current === "piano" && pianoSynthRef.current) {
        pianoSynthRef.current.updateSettings({
          volume: currSettings.volume,
          attack: currSettings.attack,
          release: currSettings.release,
        });
        const nodes = pianoSynthRef.current.createPianoSound(frequency, velocity);
        activePianoNotesRef.current.set(note, nodes);
      } else {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const peak = Math.max(0.001, Math.min(1, velocity) * 0.42);
        const attack = Math.max(0.005, currSettings.attack);

        osc.type = waveformRef.current;
        osc.frequency.setValueAtTime(frequency, now);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(peak, now + attack);

        osc.connect(gain);
        gain.connect(masterGainRef.current);
        osc.start(now);

        activeOscillatorsRef.current.set(note, { osc, gain });
      }

      syncActiveDisplay();
    },
    [ensureAudioGraph, releaseSingleNote, syncActiveDisplay],
  );

  const stopNote = useCallback(
    (note: string) => {
      if (sustainRef.current) {
        if (activePianoNotesRef.current.has(note) || activeOscillatorsRef.current.has(note)) {
          sustainedNotesRef.current.add(note);
        }
        return;
      }
      releaseSingleNote(note, false);
    },
    [releaseSingleNote],
  );

  // Release sustained notes when sustain pedal is toggled off
  useEffect(() => {
    if (!sustainOn && sustainedNotesRef.current.size > 0) {
      const notes = Array.from(sustainedNotesRef.current);
      sustainedNotesRef.current.clear();
      notes.forEach((n) => releaseSingleNote(n, false));
    }
  }, [sustainOn, releaseSingleNote]);

  // Cleanup AudioContext on unmount
  useEffect(() => {
    return () => {
      stopAllNotes(true);
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, [stopAllNotes]);

  // Optional Web MIDI API auto-detection for physical USB MIDI keyboards
  useEffect(() => {
    const nav = navigator as Navigator & {
      requestMIDIAccess?: () => Promise<{
        inputs: Map<
          string,
          {
            name?: string;
            onmidimessage: ((event: { data: Uint8Array }) => void) | null;
          }
        >;
        onstatechange: (() => void) | null;
      }>;
    };

    if (!nav.requestMIDIAccess) return;
    let active = true;

    nav
      .requestMIDIAccess()
      .then((access) => {
        if (!active) return;

        const bindInputs = () => {
          let connectedName: string | null = null;
          access.inputs.forEach((input) => {
            connectedName = input.name || "USB MIDI Keyboard";
            input.onmidimessage = (msg) => {
              if (!msg.data || msg.data.length < 2) return;
              const [status, midiNote, velocity = 0] = msg.data;
              const cmd = status & 0xf0;
              const { note, frequency } = midiNumberToNote(midiNote);

              if (cmd === 0x90 && velocity > 0) {
                setMidiActiveNotes((prev) => new Set(prev).add(note));
                playNote(frequency, note, velocity / 127);
              } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
                setMidiActiveNotes((prev) => {
                  const next = new Set(prev);
                  next.delete(note);
                  return next;
                });
                stopNote(note);
              }
            };
          });
          setMidiDeviceName(connectedName);
        };

        bindInputs();
        access.onstatechange = bindInputs;
      })
      .catch(() => {
        // Gracefully ignore when MIDI permissions are unavailable
      });

    return () => {
      active = false;
    };
  }, [playNote, stopNote]);

  const updateAudioSetting = (setting: keyof AudioSettings, value: number) => {
    setAudioSettings((prev) => ({ ...prev, [setting]: value }));
    const ctx = audioContextRef.current;
    const now = ctx?.currentTime ?? 0;

    if (setting === "volume" && masterGainRef.current) {
      masterGainRef.current.gain.setTargetAtTime(value, now, 0.015);
    } else if (setting === "filterFreq" && filterRef.current) {
      filterRef.current.frequency.setTargetAtTime(value, now, 0.015);
    } else if (setting === "reverb" && dryGainRef.current && wetGainRef.current) {
      dryGainRef.current.gain.setTargetAtTime(1 - value * 0.45, now, 0.02);
      wetGainRef.current.gain.setTargetAtTime(value * 0.9, now, 0.02);
    }
  };

  const resetAllSettings = () => {
    setAudioSettings(DEFAULT_SETTINGS);
    const ctx = audioContextRef.current;
    const now = ctx?.currentTime ?? 0;
    if (masterGainRef.current) {
      masterGainRef.current.gain.setTargetAtTime(DEFAULT_SETTINGS.volume, now, 0.02);
    }
    if (filterRef.current) {
      filterRef.current.frequency.setTargetAtTime(DEFAULT_SETTINGS.filterFreq, now, 0.02);
    }
    if (dryGainRef.current && wetGainRef.current) {
      dryGainRef.current.gain.setTargetAtTime(1 - DEFAULT_SETTINGS.reverb * 0.45, now, 0.02);
      wetGainRef.current.gain.setTargetAtTime(DEFAULT_SETTINGS.reverb * 0.9, now, 0.02);
    }
    setOctaveOffset(0);
    setSustainOn(false);
  };

  const emergencyStop = () => {
    stopAllNotes(true);
    setSustainOn(false);
    const ctx = audioContextRef.current;
    if (masterGainRef.current && ctx) {
      const now = ctx.currentTime;
      masterGainRef.current.gain.cancelScheduledValues(now);
      masterGainRef.current.gain.setValueAtTime(0, now);
      window.setTimeout(() => {
        if (masterGainRef.current && audioContextRef.current) {
          masterGainRef.current.gain.setTargetAtTime(
            settingsRef.current.volume,
            audioContextRef.current.currentTime,
            0.02,
          );
        }
      }, 90);
    }
  };

  const toggleTheme = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));

  const keyboardCommands = {
    onOctaveDown: () => setOctaveOffset((o) => Math.max(-2, o - 1)),
    onOctaveUp: () => setOctaveOffset((o) => Math.min(2, o + 1)),
    onToggleSustain: () => setSustainOn((s) => !s),
    onSelectPiano: () => {
      stopAllNotes(true);
      setSoundMode("piano");
    },
    onSelectSynth: () => {
      stopAllNotes(true);
      setSoundMode("oscillator");
    },
    onCycleWaveform: () => {
      const order: OscillatorType[] = ["sine", "triangle", "sawtooth", "square"];
      setSoundMode("oscillator");
      setWaveform((curr) => order[(order.indexOf(curr) + 1) % order.length]);
    },
    onStopAll: () => emergencyStop(),
  };

  const lowOct = 4 + octaveOffset;
  const highOct = 5 + octaveOffset;

  return (
    <div className="relative min-h-screen overflow-x-clip bg-background text-foreground transition-colors duration-300">
      {/* Subtle Ambient Red-Orange Studio Glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 -top-32 mx-auto h-72 max-w-4xl rounded-full bg-gradient-to-r from-[#dc2626]/15 via-[#ea580c]/15 to-[#f97316]/15 blur-3xl dark:from-[#dc2626]/20 dark:via-[#ea580c]/18 dark:to-[#f97316]/14"
      />

      {/* Sticky Studio Header */}
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#dc2626] via-[#ea580c] to-[#f97316] text-white shadow-[0_6px_18px_-4px_rgba(234,88,12,0.55)]">
              <PianoIcon className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight sm:text-lg">
                MIDI Controller{" "}
                <span className="bg-gradient-to-r from-[#dc2626] to-[#f97316] bg-clip-text text-transparent">
                  Studio
                </span>
              </h1>
              <p className="hidden text-xs text-muted-foreground sm:block">
                Multi-harmonic 3D Piano &amp; Real-Time Web Synthesizer
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-2.5">
            {/* Live Audio Engine Status Pill */}
            <button
              type="button"
              onClick={() => ensureAudioGraph()}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
                audioReady
                  ? "border-orange-500/35 bg-orange-500/10 text-orange-700 dark:text-orange-300"
                  : "border-red-500/40 bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300"
              }`}
              title={audioReady ? "Audio Engine Active" : "Click to unlock browser audio"}
            >
              {audioReady ? (
                <Volume2 className="size-3.5 text-orange-600 dark:text-orange-400" />
              ) : (
                <VolumeX className="size-3.5 text-red-600 dark:text-red-400" />
              )}
              <span className="hidden xs:inline sm:inline">
                {audioReady ? "Audio Active" : "Enable Audio"}
              </span>
            </button>

            {/* Light / Dark Mode Switcher */}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "Light" : "Dark"} mode`}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground shadow-xs transition-all hover:border-primary/50 hover:bg-accent cursor-pointer"
            >
              {theme === "dark" ? (
                <>
                  <Sun className="size-3.5 text-orange-400" />
                  <span>Light</span>
                </>
              ) : (
                <>
                  <Moon className="size-3.5 text-red-600" />
                  <span>Dark</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Studio Workspace */}
      <main className="relative mx-auto max-w-6xl space-y-5 px-4 py-5 sm:space-y-6 sm:px-6 sm:py-8">
        {/* Live Display Strip */}
        <section
          aria-label="Live performance monitor"
          className="flex flex-col justify-between gap-3 rounded-2xl border border-border bg-card/90 p-4 shadow-sm sm:flex-row sm:items-center sm:px-5"
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-[#dc2626]/12 to-[#f97316]/12 px-3 py-1 text-xs font-semibold text-red-700 ring-1 ring-red-500/25 dark:text-orange-300">
              <Sparkles className="size-3.5 text-orange-500" />
              {soundMode === "piano"
                ? "Grand Piano Engine"
                : `Analog Synth · ${waveform.toUpperCase()}`}
            </span>

            {midiDeviceName && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/30 bg-orange-500/10 px-3 py-1 text-xs font-medium text-orange-700 dark:text-orange-300">
                <Usb className="size-3.5" />
                {midiDeviceName}
              </span>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              Active Notes:
            </span>
            <div className="flex h-8 min-w-[120px] max-w-[260px] flex-nowrap items-center justify-center gap-1 overflow-x-auto overflow-y-hidden rounded-lg border border-border bg-muted/60 px-2.5 font-mono text-xs font-bold sm:max-w-[340px]">
              {activeNoteList.length > 0 ? (
                activeNoteList.map((n) => (
                  <span
                    key={n}
                    className="inline-flex h-5 shrink-0 items-center rounded bg-gradient-to-r from-[#dc2626] to-[#ea580c] px-1.5 text-[11px] leading-none text-white"
                  >
                    {n}
                  </span>
                ))
              ) : (
                <span className="shrink-0 leading-none text-muted-foreground/70">— Ready —</span>
              )}
            </div>
          </div>
        </section>

        {/* Sound Controls Rack */}
        <Card className="border-border/90 bg-card shadow-sm">
          <CardHeader className="gap-3 border-b border-border/70 pb-5">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <CardTitle className="text-lg font-bold sm:text-xl">Sound Controls</CardTitle>
                <CardDescription className="mt-1 text-xs sm:text-sm">
                  Drag knobs vertically, use scroll wheel, or double-click any knob to reset.
                </CardDescription>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={resetAllSettings}
                  title="Reset all controls to studio defaults"
                >
                  <RotateCcw className="size-3.5 text-orange-600 dark:text-orange-400" />
                  Reset
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={emergencyStop}
                >
                  <Square className="size-3 fill-current" />
                  Stop All
                </Button>
              </div>
            </div>

            {/* Mode, Sustain & Octave Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Mode:
                </span>
                <Button
                  type="button"
                  variant={soundMode === "piano" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    stopAllNotes(true);
                    setSoundMode("piano");
                  }}
                >
                  <PianoIcon className="size-3.5" />
                  Piano
                </Button>
                <Button
                  type="button"
                  variant={soundMode === "oscillator" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    stopAllNotes(true);
                    setSoundMode("oscillator");
                  }}
                >
                  <AudioWaveform className="size-3.5" />
                  Synthesizer
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Octave Switcher */}
                <div className="inline-flex items-center rounded-lg border border-border bg-muted/50 p-0.5">
                  <button
                    type="button"
                    aria-label="Lower octave"
                    disabled={octaveOffset <= -2}
                    onClick={() => setOctaveOffset((o) => Math.max(-2, o - 1))}
                    className="rounded-md p-1.5 text-foreground transition hover:bg-accent hover:text-primary disabled:opacity-40 cursor-pointer"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <span className="px-2 font-mono text-xs font-semibold text-foreground">
                    Oct {octaveOffset >= 0 ? `+${octaveOffset}` : octaveOffset} (C{lowOct}–B{highOct})
                  </span>
                  <button
                    type="button"
                    aria-label="Raise octave"
                    disabled={octaveOffset >= 2}
                    onClick={() => setOctaveOffset((o) => Math.min(2, o + 1))}
                    className="rounded-md p-1.5 text-foreground transition hover:bg-accent hover:text-primary disabled:opacity-40 cursor-pointer"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>

                {/* Sustain Pedal Toggle */}
                <Button
                  type="button"
                  variant={sustainOn ? "default" : "outline"}
                  size="sm"
                  aria-pressed={sustainOn}
                  onClick={() => setSustainOn((s) => !s)}
                >
                  Sustain {sustainOn ? "ON" : "OFF"}
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-5 pt-1">
            {/* 5 Interactive Rotary Studio Knobs */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5 sm:gap-4">
              <ControlKnob
                label="Volume"
                value={audioSettings.volume}
                min={0}
                max={1}
                defaultValue={DEFAULT_SETTINGS.volume}
                onChange={(v) => updateAudioSetting("volume", v)}
                formatValue={(v) => `${Math.round(v * 100)}%`}
              />
              <ControlKnob
                label="Attack"
                value={audioSettings.attack}
                min={0.005}
                max={1}
                defaultValue={DEFAULT_SETTINGS.attack}
                onChange={(v) => updateAudioSetting("attack", v)}
                formatValue={(v) => `${v.toFixed(2)}s`}
              />
              <ControlKnob
                label="Release"
                value={audioSettings.release}
                min={0.05}
                max={3}
                defaultValue={DEFAULT_SETTINGS.release}
                onChange={(v) => updateAudioSetting("release", v)}
                formatValue={(v) => `${v.toFixed(2)}s`}
              />
              <ControlKnob
                label="Filter"
                value={audioSettings.filterFreq}
                min={150}
                max={8000}
                defaultValue={DEFAULT_SETTINGS.filterFreq}
                onChange={(v) => updateAudioSetting("filterFreq", v)}
                formatValue={(v) =>
                  v >= 1000 ? `${(v / 1000).toFixed(1)}kHz` : `${Math.round(v)}Hz`
                }
              />
              <div className="col-span-2 sm:col-span-1">
                <ControlKnob
                  label="Reverb"
                  value={audioSettings.reverb}
                  min={0}
                  max={1}
                  defaultValue={DEFAULT_SETTINGS.reverb}
                  onChange={(v) => updateAudioSetting("reverb", v)}
                  formatValue={(v) => `${Math.round(v * 100)}%`}
                />
              </div>
            </div>

            {/* Oscillator Waveforms OR Piano Engine Info */}
            {soundMode === "oscillator" ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 p-3.5">
                <span className="mr-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Waveform:
                </span>
                {(["sine", "triangle", "sawtooth", "square"] as OscillatorType[]).map((wave) => (
                  <Button
                    key={wave}
                    type="button"
                    variant={waveform === wave ? "default" : "outline"}
                    size="sm"
                    onClick={() => setWaveform(wave)}
                    className="capitalize"
                  >
                    {wave}
                  </Button>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-orange-500/25 bg-gradient-to-r from-[#dc2626]/[0.06] via-[#ea580c]/[0.06] to-[#f97316]/[0.06] px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                <strong className="font-semibold text-foreground">Multi-Harmonic Piano:</strong>{" "}
                Synthesizes 5 harmonic partials with hammer strike transient, dynamic low-pass
                filtering, and real-time stereo concert reverb. Press any key to start playing
                immediately.
              </div>
            )}
          </CardContent>
        </Card>

        {/* 3D Tactile Piano Keyboard Section */}
        <Card className="border-border/90 bg-card shadow-sm">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-2">
            <div>
              <CardTitle className="text-lg font-bold sm:text-xl">
                3D Piano Keyboard
              </CardTitle>
              <CardDescription className="mt-1 text-xs sm:text-sm">
                Click, multi-touch, play with your computer keyboard, or plug in a USB MIDI device.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={deviceKeyboardOpen ? "default" : "outline"}
                size="sm"
                aria-pressed={deviceKeyboardOpen}
                onClick={() => {
                  ensureAudioGraph();
                  const input = document.getElementById(
                    "piano-device-keyboard",
                  ) as HTMLInputElement | null;
                  if (deviceKeyboardOpen) {
                    input?.blur();
                    setDeviceKeyboardOpen(false);
                  } else {
                    // Synchronous focus inside user click ensures iOS Safari & Android Chrome open the built-in keyboard
                    input?.focus({ preventScroll: true });
                    setDeviceKeyboardOpen(true);
                  }
                }}
                title="Open your mobile or tablet built-in keyboard to play notes & shortcuts"
              >
                <Keyboard className="size-3.5" />
                {deviceKeyboardOpen ? "Keyboard Active" : "Device Keyboard"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowKeyLabels((v) => !v)}
              >
                {showKeyLabels ? (
                  <>
                    <EyeOff className="size-3.5 text-orange-600 dark:text-orange-400" />
                    Hide Labels
                  </>
                ) : (
                  <>
                    <Eye className="size-3.5 text-orange-600 dark:text-orange-400" />
                    Show Labels
                  </>
                )}
              </Button>
            </div>
          </CardHeader>

          <CardContent className="pt-2">
            <Piano
              onNotePlay={playNote}
              onNoteStop={stopNote}
              octaveOffset={octaveOffset}
              showLabels={showKeyLabels}
              externalActiveNotes={midiActiveNotes}
              keyboardActive={deviceKeyboardOpen}
              onKeyboardActiveChange={setDeviceKeyboardOpen}
              commands={keyboardCommands}
            />
          </CardContent>
        </Card>

        {/* Keyboard Shortcut Reference */}
        <Card className="border-border/90 bg-card shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base font-bold sm:text-lg">
              <Keyboard className="size-4 text-primary" />
              Keyboard Controls (Desktop, Tablet &amp; Mobile Built-In Keyboard)
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              Works with physical desktop/Bluetooth keyboards and your phone or tablet&apos;s
              built-in keyboard via the &ldquo;Device Keyboard&rdquo; button above.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-border bg-muted/40 p-4">
                <h3 className="mb-2.5 text-sm font-semibold text-foreground">
                  Lower Octave (C{lowOct} – B{lowOct})
                </h3>
                <div className="space-y-2 text-xs text-muted-foreground sm:text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">White keys:</span>
                    {["A", "S", "D", "F", "G", "H", "J"].map((k) => (
                      <kbd
                        key={k}
                        className="rounded-md border border-border bg-card px-2 py-0.5 font-mono text-xs font-bold text-orange-700 shadow-2xs dark:text-orange-300"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">Black keys:</span>
                    {["W", "E", "T", "Y", "U"].map((k) => (
                      <kbd
                        key={k}
                        className="rounded-md bg-gradient-to-r from-[#dc2626] to-[#ea580c] px-2 py-0.5 font-mono text-xs font-bold text-white shadow-2xs"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-muted/40 p-4">
                <h3 className="mb-2.5 text-sm font-semibold text-foreground">
                  Higher Octave (C{highOct} – B{highOct})
                </h3>
                <div className="space-y-2 text-xs text-muted-foreground sm:text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">White keys:</span>
                    {["K", "L", ";", "'", "↵", "Z", "C"].map((k) => (
                      <kbd
                        key={k}
                        className="rounded-md border border-border bg-card px-2 py-0.5 font-mono text-xs font-bold text-orange-700 shadow-2xs dark:text-orange-300"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">Black keys:</span>
                    {["O", "P", "]", "\\", "X"].map((k) => (
                      <kbd
                        key={k}
                        className="rounded-md bg-gradient-to-r from-[#dc2626] to-[#ea580c] px-2 py-0.5 font-mono text-xs font-bold text-white shadow-2xs"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Studio Function Shortcuts */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono font-bold text-foreground">
                  Space
                </kbd>
                <span>Toggle Sustain</span>
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono font-bold text-foreground">
                  -
                </kbd>
                <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono font-bold text-foreground">
                  +
                </kbd>
                <span>Shift Octave</span>
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono font-bold text-foreground">
                  1
                </kbd>
                <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono font-bold text-foreground">
                  2
                </kbd>
                <span>Piano / Synth Mode</span>
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono font-bold text-foreground">
                  3
                </kbd>
                <span>Cycle Waveform</span>
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono font-bold text-foreground">
                  Esc
                </kbd>
                <span>Stop All Notes</span>
              </span>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default MidiController;

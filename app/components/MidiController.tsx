import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
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
import RecordingPanel, { type RecordingStatusMessage } from "./RecordingPanel";
import { PianoSynthesizer, type PianoNoteNodes } from "./PianoSynthesizer";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { StudioAudioRecorder } from "../lib/audioRecorder";
import {
  clearAllRecordings,
  deleteRecording,
  isIndexedDBSupported,
  listValidRecordings,
  saveRecording,
  type StoredRecording,
} from "../lib/recordingStorage";
import type { EncodedWavResult } from "../lib/wavEncoder";

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

  // Local .WAV audio recording state (IndexedDB + strict 30-min expiration)
  const [storageSupported] = useState<boolean>(() => isIndexedDBSupported());
  const [recordingEnabled, setRecordingEnabled] = useState(false);
  const [hasCapturedAudio, setHasCapturedAudio] = useState(false);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [recordings, setRecordings] = useState<StoredRecording[]>([]);
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatusMessage | null>(null);

  const [audioSettings, setAudioSettings] = useState<AudioSettings>(DEFAULT_SETTINGS);

  // Refs for real-time audio graph without stale closures
  const audioContextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const filterRef = useRef<BiquadFilterNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const pianoSynthRef = useRef<PianoSynthesizer | null>(null);
  const recorderRef = useRef<StudioAudioRecorder | null>(null);
  const statusTimerRef = useRef<number | null>(null);

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
      compressorRef.current = compressor;
      pianoSynthRef.current = new PianoSynthesizer(ctx, masterGain);

      if (!recorderRef.current) {
        recorderRef.current = new StudioAudioRecorder();
      }
      void recorderRef.current.attach(ctx, compressor);

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

  // Cleanup AudioContext & Recorder on unmount
  useEffect(() => {
    return () => {
      if (statusTimerRef.current) {
        window.clearTimeout(statusTimerRef.current);
      }
      recorderRef.current?.dispose();
      recorderRef.current = null;
      stopAllNotes(true);
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, [stopAllNotes]);

  const showRecordingStatus = useCallback(
    (type: RecordingStatusMessage["type"], text: string, autoClearMs = 6000) => {
      if (statusTimerRef.current) {
        window.clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
      }
      setRecordingStatus({ type, text });
      if (autoClearMs > 0) {
        statusTimerRef.current = window.setTimeout(() => {
          setRecordingStatus(null);
          statusTimerRef.current = null;
        }, autoClearMs);
      }
    },
    [],
  );

  // Synchronize local IndexedDB recordings and purge any recordings older than 30 minutes
  const refreshValidRecordings = useCallback(
    async (notifyIfPurged = false) => {
      if (!storageSupported) return;
      try {
        const { recordings: valid, purgedCount } = await listValidRecordings();
        setRecordings(valid);
        if (notifyIfPurged && purgedCount > 0) {
          showRecordingStatus(
            "info",
            `Automatically deleted ${purgedCount} expired recording${purgedCount > 1 ? "s" : ""} (30-minute limit reached).`,
          );
        }
      } catch {
        showRecordingStatus(
          "error",
          "Could not access browser local storage (IndexedDB). Check private-browsing storage settings.",
          0,
        );
      }
    },
    [storageSupported, showRecordingStatus],
  );

  const persistEncodedWav = useCallback(
    async (wav: EncodedWavResult | null, reason: "manual" | "toggle-off" | "auto-split") => {
      if (!wav || wav.peakAmplitude <= 0.0004 || wav.durationSec < 0.05) {
        if (reason === "toggle-off") {
          showRecordingStatus(
            "info",
            "Recording disabled — no audio was played while recording was enabled.",
          );
        } else if (reason === "manual") {
          showRecordingStatus("info", "Play piano or synth keys first before saving a .WAV take.");
        }
        return;
      }

      try {
        await saveRecording({
          mode: soundModeRef.current,
          blob: wav.blob,
          durationSec: wav.durationSec,
          sampleRate: wav.sampleRate,
          sizeBytes: wav.sizeBytes,
        });
        await refreshValidRecordings(false);
        const prefix =
          reason === "auto-split"
            ? "Auto-saved 5-minute .WAV segment"
            : "Saved genuine .WAV recording";
        showRecordingStatus("success", `${prefix} locally in your browser (valid for 30 minutes).`);
      } catch {
        showRecordingStatus(
          "error",
          "Failed to save .WAV recording to local browser storage (storage quota may be full).",
          8000,
        );
      }
    },
    [refreshValidRecordings, showRecordingStatus],
  );

  // Wire recorder callbacks (auto-split & live signal indicator)
  useEffect(() => {
    if (!recorderRef.current) {
      recorderRef.current = new StudioAudioRecorder();
    }
    recorderRef.current.setCallbacks({
      onSignalDetected: () => setHasCapturedAudio(true),
      onAutoSplit: (wav) => {
        setHasCapturedAudio(false);
        setRecordingElapsed(0);
        void persistEncodedWav(wav, "auto-split");
      },
    });
  }, [persistEncodedWav]);

  // Startup, browser-refresh, tab-focus, and periodic 30-minute automatic expiry enforcement
  useEffect(() => {
    if (!storageSupported) return;

    void refreshValidRecordings(false);

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "visible") {
        void refreshValidRecordings(true);
      }
    };

    const backupInterval = window.setInterval(() => {
      void refreshValidRecordings(true);
    }, 30_000);

    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    window.addEventListener("focus", handleVisibilityOrFocus);

    return () => {
      window.clearInterval(backupInterval);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      window.removeEventListener("focus", handleVisibilityOrFocus);
    };
  }, [storageSupported, refreshValidRecordings]);

  // Exact timer scheduled for the earliest expiring recording so deletion happens right at 30 minutes
  useEffect(() => {
    if (recordings.length === 0) return;
    const earliestExpiry = recordings.reduce(
      (min, rec) => (rec.expiresAt < min ? rec.expiresAt : min),
      recordings[0].expiresAt,
    );
    const delayMs = Math.max(150, earliestExpiry - Date.now() + 150);
    const timeoutId = window.setTimeout(() => {
      void refreshValidRecordings(true);
    }, delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [recordings, refreshValidRecordings]);

  // Live capture elapsed timer while recording is enabled
  useEffect(() => {
    if (!recordingEnabled) {
      setHasCapturedAudio(false);
      setRecordingElapsed(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      const rec = recorderRef.current;
      if (!rec || !rec.active) return;
      if (rec.hasAudioSignal) {
        setHasCapturedAudio(true);
        setRecordingElapsed(rec.elapsedSeconds);
      }
    }, 250);

    return () => window.clearInterval(intervalId);
  }, [recordingEnabled]);

  const handleToggleRecording = useCallback(async () => {
    if (!storageSupported) {
      showRecordingStatus(
        "error",
        "IndexedDB local storage is unavailable in this browser session.",
        0,
      );
      return;
    }

    if (recordingEnabled) {
      setRecordingEnabled(false);
      setHasCapturedAudio(false);
      setRecordingElapsed(0);
      const wav = recorderRef.current?.stopAndEncode() ?? null;
      await persistEncodedWav(wav, "toggle-off");
      return;
    }

    const ctx = ensureAudioGraph();
    const compressor = compressorRef.current;
    if (!ctx || !compressor) {
      showRecordingStatus("error", "Audio engine could not be initialized for recording.", 6000);
      return;
    }

    if (!recorderRef.current) {
      recorderRef.current = new StudioAudioRecorder();
    }
    recorderRef.current.setCallbacks({
      onSignalDetected: () => setHasCapturedAudio(true),
      onAutoSplit: (wav) => {
        setHasCapturedAudio(false);
        setRecordingElapsed(0);
        void persistEncodedWav(wav, "auto-split");
      },
    });

    await recorderRef.current.attach(ctx, compressor);
    recorderRef.current.start();
    setHasCapturedAudio(false);
    setRecordingElapsed(0);
    setRecordingEnabled(true);
    showRecordingStatus(
      "info",
      "Recording enabled — play piano or synthesizer keys to capture genuine .WAV audio locally.",
    );
  }, [storageSupported, recordingEnabled, ensureAudioGraph, persistEncodedWav, showRecordingStatus]);

  const handleSaveTakeNow = useCallback(async () => {
    if (!recordingEnabled || !recorderRef.current) return;
    const wav = recorderRef.current.saveTakeAndContinue();
    setHasCapturedAudio(false);
    setRecordingElapsed(0);
    await persistEncodedWav(wav, "manual");
  }, [recordingEnabled, persistEncodedWav]);

  const handleDeleteRecording = useCallback(
    async (id: string) => {
      try {
        await deleteRecording(id);
        await refreshValidRecordings(false);
        showRecordingStatus("info", "Deleted recording from local browser storage.", 4000);
      } catch {
        showRecordingStatus("error", "Failed to delete recording.", 5000);
      }
    },
    [refreshValidRecordings, showRecordingStatus],
  );

  const handleClearAllRecordings = useCallback(async () => {
    try {
      await clearAllRecordings();
      setRecordings([]);
      showRecordingStatus("info", "Cleared all local recordings from browser storage.", 4000);
    } catch {
      showRecordingStatus("error", "Failed to clear local recordings.", 5000);
    }
  }, [showRecordingStatus]);

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

  const emergencyStop = useCallback(() => {
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
  }, [stopAllNotes]);

  // Conflict-free centralized mode switcher (Piano <-> Synthesizer) with smooth audio handoff
  const switchSoundMode = useCallback(
    (nextMode: SoundMode) => {
      // No-op when clicking the already active mode so playing/sustained audio is never interrupted
      if (soundModeRef.current === nextMode) return;

      const prevMode = soundModeRef.current;
      soundModeRef.current = nextMode;
      setSoundMode(nextMode);

      // Gently fade out only active voices belonging to the previous engine without clicks or state glitches
      const prevNotes =
        prevMode === "piano"
          ? Array.from(activePianoNotesRef.current.keys())
          : Array.from(activeOscillatorsRef.current.keys());
      prevNotes.forEach((n) => releaseSingleNote(n, true));
    },
    [releaseSingleNote],
  );

  const selectWaveform = useCallback(
    (nextWave: OscillatorType) => {
      waveformRef.current = nextWave;
      setWaveform(nextWave);
      if (soundModeRef.current !== "oscillator") {
        switchSoundMode("oscillator");
      }
    },
    [switchSoundMode],
  );

  const toggleTheme = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));

  const keyboardCommands = useMemo(
    () => ({
      onOctaveDown: () => setOctaveOffset((o) => Math.max(-2, o - 1)),
      onOctaveUp: () => setOctaveOffset((o) => Math.min(2, o + 1)),
      onToggleSustain: () => setSustainOn((s) => !s),
      onSelectPiano: () => switchSoundMode("piano"),
      onSelectSynth: () => switchSoundMode("oscillator"),
      onCycleWaveform: () => {
        const order: OscillatorType[] = ["sine", "triangle", "sawtooth", "square"];
        const next = order[(order.indexOf(waveformRef.current) + 1) % order.length];
        selectWaveform(next);
      },
      onStopAll: () => emergencyStop(),
    }),
    [switchSoundMode, selectWaveform, emergencyStop],
  );

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
            {/* Live Recording Header Indicator */}
            {recordingEnabled && (
              <a
                href="#local-audio-recorder"
                className="studio-panel-in inline-flex items-center gap-1.5 rounded-full border border-red-500/45 bg-red-500/12 px-2.5 py-1.5 text-xs font-bold text-red-700 transition hover:bg-red-500/20 dark:text-red-300"
                title="Local .WAV recording is active — click to jump to recorder"
              >
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-red-600" />
                </span>
                <span>REC</span>
              </a>
            )}

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
            <span
              key={`${soundMode}-${soundMode === "oscillator" ? waveform : "grand"}`}
              className="studio-badge-swap inline-flex min-w-[196px] items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-[#dc2626]/12 to-[#f97316]/12 px-3 py-1 text-xs font-semibold text-red-700 ring-1 ring-red-500/25 dark:text-orange-300"
            >
              <Sparkles className="size-3.5 shrink-0 text-orange-500" />
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
              <div className="flex flex-wrap items-center gap-2.5">
                <span
                  id="sound-mode-label"
                  className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                  Mode:
                </span>

                {/* Animated Sliding Segmented Mode Control (Zero conflict, zero layout jump) */}
                <div
                  role="tablist"
                  aria-labelledby="sound-mode-label"
                  className="relative grid grid-cols-2 items-center rounded-xl border border-border bg-muted/65 p-1 shadow-2xs"
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-4px)] rounded-lg bg-gradient-to-r from-[#dc2626] via-[#ea580c] to-[#f97316] shadow-[0_4px_14px_-3px_rgba(234,88,12,0.55)] transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                      soundMode === "oscillator" ? "translate-x-full" : "translate-x-0"
                    }`}
                  />

                  <button
                    type="button"
                    role="tab"
                    id="mode-tab-piano"
                    aria-selected={soundMode === "piano"}
                    aria-controls="mode-panel-piano"
                    onClick={(e) => {
                      switchSoundMode("piano");
                      if (e.detail > 0) e.currentTarget.blur();
                    }}
                    className={`relative z-10 inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold transition-colors duration-200 select-none cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm ${
                      soundMode === "piano"
                        ? "text-white"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <PianoIcon className="size-3.5 shrink-0" />
                    <span>Piano</span>
                  </button>

                  <button
                    type="button"
                    role="tab"
                    id="mode-tab-synthesizer"
                    aria-selected={soundMode === "oscillator"}
                    aria-controls="mode-panel-synthesizer"
                    onClick={(e) => {
                      switchSoundMode("oscillator");
                      if (e.detail > 0) e.currentTarget.blur();
                    }}
                    className={`relative z-10 inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold transition-colors duration-200 select-none cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm ${
                      soundMode === "oscillator"
                        ? "text-white"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <AudioWaveform className="size-3.5 shrink-0" />
                    <span>Synthesizer</span>
                  </button>
                </div>
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

            {/* Height-Stabilized Cross-Fade Mode Panel (Zero layout shift between Piano & Synthesizer) */}
            <div className="grid grid-cols-1 items-stretch">
              <div
                id="mode-panel-piano"
                role="tabpanel"
                aria-labelledby="mode-tab-piano"
                aria-hidden={soundMode !== "piano"}
                className={`studio-mode-panel col-start-1 row-start-1 flex items-center rounded-xl border border-orange-500/25 bg-gradient-to-r from-[#dc2626]/[0.06] via-[#ea580c]/[0.06] to-[#f97316]/[0.06] px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:text-sm ${
                  soundMode === "piano"
                    ? "visible translate-y-0 opacity-100 pointer-events-auto"
                    : "invisible translate-y-1.5 opacity-0 pointer-events-none"
                }`}
              >
                <p>
                  <strong className="font-semibold text-foreground">Multi-Harmonic Piano:</strong>{" "}
                  Synthesizes 5 harmonic partials with hammer strike transient, dynamic low-pass
                  filtering, and real-time stereo concert reverb. Press any key to start playing
                  immediately.
                </p>
              </div>

              <div
                id="mode-panel-synthesizer"
                role="tabpanel"
                aria-labelledby="mode-tab-synthesizer"
                aria-hidden={soundMode !== "oscillator"}
                className={`studio-mode-panel col-start-1 row-start-1 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 ${
                  soundMode === "oscillator"
                    ? "visible translate-y-0 opacity-100 pointer-events-auto"
                    : "invisible -translate-y-1.5 opacity-0 pointer-events-none"
                }`}
              >
                <span className="mr-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Waveform:
                </span>
                {(["sine", "triangle", "sawtooth", "square"] as OscillatorType[]).map((wave) => {
                  const selected = waveform === wave;
                  return (
                    <button
                      key={wave}
                      type="button"
                      tabIndex={soundMode === "oscillator" ? 0 : -1}
                      aria-pressed={selected}
                      onClick={(e) => {
                        selectWaveform(wave);
                        if (e.detail > 0) e.currentTarget.blur();
                      }}
                      className={`inline-flex h-8.5 items-center justify-center rounded-lg border px-3 text-xs font-semibold capitalize transition-all duration-200 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] sm:text-sm ${
                        selected
                          ? "border-transparent bg-gradient-to-r from-[#dc2626] via-[#ea580c] to-[#f97316] text-white shadow-[0_4px_14px_-3px_rgba(234,88,12,0.5)]"
                          : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-accent hover:text-accent-foreground"
                      }`}
                    >
                      {wave}
                    </button>
                  );
                })}
              </div>
            </div>
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

        {/* Local .WAV Audio Recorder & 30-Minute IndexedDB Manager */}
        <section id="local-audio-recorder" aria-label="Local audio recorder" className="scroll-mt-20">
          <RecordingPanel
            recordingEnabled={recordingEnabled}
            hasCapturedAudio={hasCapturedAudio}
            elapsedSeconds={recordingElapsed}
            recordings={recordings}
            storageSupported={storageSupported}
            statusMessage={recordingStatus}
            onToggleRecording={() => {
              void handleToggleRecording();
            }}
            onSaveTakeNow={() => {
              void handleSaveTakeNow();
            }}
            onDeleteRecording={(id) => {
              void handleDeleteRecording(id);
            }}
            onClearAll={() => {
              void handleClearAllRecordings();
            }}
            onRecordingsExpired={() => {
              void refreshValidRecordings(true);
            }}
          />
        </section>

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

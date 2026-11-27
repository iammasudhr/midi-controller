import React, { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard } from "lucide-react";

export interface KeyboardCommandHandlers {
  onOctaveDown?: () => void;
  onOctaveUp?: () => void;
  onToggleSustain?: () => void;
  onSelectPiano?: () => void;
  onSelectSynth?: () => void;
  onCycleWaveform?: () => void;
  onStopAll?: () => void;
}

interface PianoProps {
  onNotePlay: (frequency: number, note: string, velocity?: number) => void;
  onNoteStop: (note: string) => void;
  octaveOffset?: number;
  showLabels?: boolean;
  externalActiveNotes?: Set<string>;
  keyboardActive?: boolean;
  onKeyboardActiveChange?: (active: boolean) => void;
  commands?: KeyboardCommandHandlers;
}

interface PianoKeyDef {
  note: string;
  baseName: string;
  frequency: number;
  type: "white" | "black";
  position: number;
  key: string;
  displayKey: string;
}

const BASE_OCTAVE: Array<{
  baseName: string;
  frequency: number;
  type: "white" | "black";
  position: number;
  lowerKey: string;
  upperKey: string;
}> = [
  { baseName: "C", frequency: 261.63, type: "white", position: 0, lowerKey: "a", upperKey: "k" },
  { baseName: "C#", frequency: 277.18, type: "black", position: 0, lowerKey: "w", upperKey: "o" },
  { baseName: "D", frequency: 293.66, type: "white", position: 1, lowerKey: "s", upperKey: "l" },
  { baseName: "D#", frequency: 311.13, type: "black", position: 1, lowerKey: "e", upperKey: "p" },
  { baseName: "E", frequency: 329.63, type: "white", position: 2, lowerKey: "d", upperKey: ";" },
  { baseName: "F", frequency: 349.23, type: "white", position: 3, lowerKey: "f", upperKey: "'" },
  { baseName: "F#", frequency: 369.99, type: "black", position: 3, lowerKey: "t", upperKey: "]" },
  { baseName: "G", frequency: 392.0, type: "white", position: 4, lowerKey: "g", upperKey: "enter" },
  { baseName: "G#", frequency: 415.3, type: "black", position: 4, lowerKey: "y", upperKey: "\\" },
  { baseName: "A", frequency: 440.0, type: "white", position: 5, lowerKey: "h", upperKey: "z" },
  { baseName: "A#", frequency: 466.16, type: "black", position: 5, lowerKey: "u", upperKey: "x" },
  { baseName: "B", frequency: 493.88, type: "white", position: 6, lowerKey: "j", upperKey: "c" },
];

const WHITE_KEY_COUNT = 14;
const WHITE_KEY_PCT = 100 / WHITE_KEY_COUNT;
const BLACK_KEY_PCT = WHITE_KEY_PCT * 0.62;
const SOFT_KEY_PULSE_MS = 320;

const Piano: React.FC<PianoProps> = ({
  onNotePlay,
  onNoteStop,
  octaveOffset = 0,
  showLabels = true,
  externalActiveNotes,
  keyboardActive = false,
  onKeyboardActiveChange,
  commands,
}) => {
  const [pressedNotes, setPressedNotes] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const keybedRef = useRef<HTMLDivElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);

  // Track active sources per note so mouse + touch + physical keyboard + soft keyboard never collide
  const activeKeyboardKeysRef = useRef<Map<string, string>>(new Map());
  const activePointersRef = useRef<Map<number, string>>(new Map());
  const softKeyTimersRef = useRef<Map<string, number>>(new Map());
  const lastPhysicalKeyRef = useRef<{ key: string; ts: number }>({ key: "", ts: 0 });

  const onNotePlayRef = useRef(onNotePlay);
  const onNoteStopRef = useRef(onNoteStop);
  const commandsRef = useRef(commands);
  onNotePlayRef.current = onNotePlay;
  onNoteStopRef.current = onNoteStop;
  commandsRef.current = commands;

  const allNotes = useMemo<PianoKeyDef[]>(() => {
    const mult = Math.pow(2, octaveOffset);
    const lowOct = 4 + octaveOffset;
    const highOct = 5 + octaveOffset;

    const lower: PianoKeyDef[] = BASE_OCTAVE.map((n) => ({
      note: `${n.baseName}${lowOct}`,
      baseName: n.baseName,
      frequency: n.frequency * mult,
      type: n.type,
      position: n.position,
      key: n.lowerKey,
      displayKey: n.lowerKey.toUpperCase(),
    }));

    const upper: PianoKeyDef[] = BASE_OCTAVE.map((n) => ({
      note: `${n.baseName}${highOct}`,
      baseName: n.baseName,
      frequency: n.frequency * 2 * mult,
      type: n.type,
      position: n.position + 7,
      key: n.upperKey,
      displayKey: n.upperKey === "enter" ? "↵" : n.upperKey.toUpperCase(),
    }));

    return [...lower, ...upper];
  }, [octaveOffset]);

  const whiteKeys = useMemo(() => allNotes.filter((n) => n.type === "white"), [allNotes]);
  const blackKeys = useMemo(() => allNotes.filter((n) => n.type === "black"), [allNotes]);
  const keyboardMap = useMemo(
    () => new Map(allNotes.map((n) => [n.key.toLowerCase(), n])),
    [allNotes],
  );

  const syncVisualPressed = () => {
    const next = new Set<string>();
    activeKeyboardKeysRef.current.forEach((note) => next.add(note));
    activePointersRef.current.forEach((note) => next.add(note));
    softKeyTimersRef.current.forEach((_, note) => next.add(note));
    setPressedNotes(next);
  };

  const triggerNoteDown = (note: string, frequency: number) => {
    onNotePlayRef.current(frequency, note);
  };

  const triggerNoteUp = (note: string) => {
    let stillHeld = false;
    activeKeyboardKeysRef.current.forEach((n) => {
      if (n === note) stillHeld = true;
    });
    activePointersRef.current.forEach((n) => {
      if (n === note) stillHeld = true;
    });
    if (softKeyTimersRef.current.has(note)) {
      stillHeld = true;
    }
    if (!stillHeld) {
      onNoteStopRef.current(note);
    }
  };

  const isAppCommandKey = (key: string): boolean =>
    key === "-" ||
    key === "_" ||
    key === "=" ||
    key === "+" ||
    key === " " ||
    key === "1" ||
    key === "2" ||
    key === "3" ||
    key === "escape";

  // Dispatch app-level keyboard commands consistently across physical & mobile soft keyboards
  const handleAppCommand = (key: string): boolean => {
    const cmds = commandsRef.current;
    if (!cmds) return false;
    if (key === "-" || key === "_") {
      cmds.onOctaveDown?.();
      return true;
    }
    if (key === "=" || key === "+") {
      cmds.onOctaveUp?.();
      return true;
    }
    if (key === " ") {
      cmds.onToggleSustain?.();
      return true;
    }
    if (key === "1") {
      cmds.onSelectPiano?.();
      return true;
    }
    if (key === "2") {
      cmds.onSelectSynth?.();
      return true;
    }
    if (key === "3") {
      cmds.onCycleWaveform?.();
      return true;
    }
    if (key === "escape") {
      cmds.onStopAll?.();
      return true;
    }
    return false;
  };

  // Trigger a crisp press-and-release pulse for mobile/tablet soft keyboard taps
  const triggerSoftKey = (rawChar: string) => {
    const mapped = rawChar === "\n" || rawChar === "\r" ? "enter" : rawChar.toLowerCase();

    // Prevent double-trigger if a real physical keydown already handled this exact key <60ms ago
    const now = performance.now();
    if (
      lastPhysicalKeyRef.current.key === mapped &&
      now - lastPhysicalKeyRef.current.ts < 80
    ) {
      return;
    }

    if (handleAppCommand(mapped)) return;

    const noteData = keyboardMap.get(mapped);
    if (!noteData) return;

    const existingTimer = softKeyTimersRef.current.get(noteData.note);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    triggerNoteDown(noteData.note, noteData.frequency);
    const timerId = window.setTimeout(() => {
      softKeyTimersRef.current.delete(noteData.note);
      syncVisualPressed();
      triggerNoteUp(noteData.note);
    }, SOFT_KEY_PULSE_MS);

    softKeyTimersRef.current.set(noteData.note, timerId);
    syncVisualPressed();

    // Gently keep played key visible on narrow mobile screens
    if (scrollRef.current && scrollRef.current.scrollWidth > scrollRef.current.clientWidth) {
      const targetRatio = noteData.position / WHITE_KEY_COUNT;
      const desiredLeft =
        targetRatio * scrollRef.current.scrollWidth - scrollRef.current.clientWidth * 0.42;
      scrollRef.current.scrollTo({
        left: Math.max(0, desiredLeft),
        behavior: "smooth",
      });
    }
  };

  // Sync focus when user toggles the mobile/tablet built-in keyboard mode
  useEffect(() => {
    const input = mobileInputRef.current;
    if (!input) return;
    if (keyboardActive) {
      input.focus({ preventScroll: true });
    } else if (document.activeElement === input) {
      input.blur();
    }
  }, [keyboardActive]);

  // Clear held notes cleanly when octave changes
  useEffect(() => {
    const toStop = new Set<string>([
      ...activeKeyboardKeysRef.current.values(),
      ...activePointersRef.current.values(),
      ...softKeyTimersRef.current.keys(),
    ]);
    softKeyTimersRef.current.forEach((id) => window.clearTimeout(id));
    softKeyTimersRef.current.clear();
    activeKeyboardKeysRef.current.clear();
    activePointersRef.current.clear();
    setPressedNotes(new Set());
    toStop.forEach((n) => onNoteStopRef.current(n));
  }, [octaveOffset]);

  // Prevent touch-drag page scroll on the interactive keybed surface (iOS Safari / mobile fallback)
  useEffect(() => {
    const el = keybedRef.current;
    if (!el) return;
    const blockTouchScroll = (e: TouchEvent) => {
      if (e.cancelable) {
        e.preventDefault();
      }
    };
    el.addEventListener("touchmove", blockTouchScroll, { passive: false });
    return () => {
      el.removeEventListener("touchmove", blockTouchScroll);
    };
  }, []);

  // Physical / Bluetooth / Desktop keyboard support
  useEffect(() => {
    const normalizeKey = (event: KeyboardEvent): string => {
      const code = event.code.toLowerCase();
      if (code === "enter") return "enter";
      if (code === "space") return " ";
      if (code === "minus") return "-";
      if (code === "equal") return "=";
      if (code === "semicolon") return ";";
      if (code === "quote") return "'";
      if (code === "bracketright") return "]";
      if (code === "backslash") return "\\";
      if (code === "escape") return "escape";
      if (event.key === "Unidentified" || event.keyCode === 229) return "";
      return event.key.toLowerCase();
    };

    const isOtherEditableTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      if (el.dataset?.pianoKeyboardInput === "true") return false;
      return (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable
      );
    };

    const handleKeyboardDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isOtherEditableTarget(event.target)) return;

      const mappedKey = normalizeKey(event);
      if (!mappedKey) return; // Mobile IME / Android soft keyboard -> handled by input event

      const isCommand = isAppCommandKey(mappedKey);
      const noteData = keyboardMap.get(mappedKey);
      if (!isCommand && !noteData) return;

      // Always block default scrolling/button activation — including on key auto-repeat (e.g. holding Space)
      event.preventDefault();
      event.stopPropagation();

      if (event.repeat) return;

      // Record timestamp so mobile input event doesn't double-fire the same keypress
      lastPhysicalKeyRef.current = { key: mappedKey, ts: performance.now() };

      if (isCommand) {
        handleAppCommand(mappedKey);
        return;
      }

      if (noteData && !activeKeyboardKeysRef.current.has(mappedKey)) {
        activeKeyboardKeysRef.current.set(mappedKey, noteData.note);
        syncVisualPressed();
        triggerNoteDown(noteData.note, noteData.frequency);
      }
    };

    const handleKeyboardUp = (event: KeyboardEvent) => {
      const mappedKey = normalizeKey(event);
      if (!mappedKey) return;

      if (
        (isAppCommandKey(mappedKey) || mappedKey === "enter" || keyboardMap.has(mappedKey)) &&
        !isOtherEditableTarget(event.target)
      ) {
        event.preventDefault();
        event.stopPropagation();
      }

      const heldNote = activeKeyboardKeysRef.current.get(mappedKey);
      if (heldNote) {
        activeKeyboardKeysRef.current.delete(mappedKey);
        syncVisualPressed();
        triggerNoteUp(heldNote);
      }
    };

    const handleBlur = () => {
      const toStop = new Set<string>([
        ...activeKeyboardKeysRef.current.values(),
        ...activePointersRef.current.values(),
        ...softKeyTimersRef.current.keys(),
      ]);
      softKeyTimersRef.current.forEach((id) => window.clearTimeout(id));
      softKeyTimersRef.current.clear();
      activeKeyboardKeysRef.current.clear();
      activePointersRef.current.clear();
      setPressedNotes(new Set());
      toStop.forEach((n) => onNoteStopRef.current(n));
    };

    window.addEventListener("keydown", handleKeyboardDown, { capture: true });
    window.addEventListener("keyup", handleKeyboardUp, { capture: true });
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyboardDown, { capture: true });
      window.removeEventListener("keyup", handleKeyboardUp, { capture: true });
      window.removeEventListener("blur", handleBlur);
    };
  }, [keyboardMap]);

  // Built-in mobile/tablet soft keyboard input handlers (Android Gboard / Samsung / iOS)
  const handleMobileBeforeInput = (e: React.FormEvent<HTMLInputElement>) => {
    const native = e.nativeEvent as InputEvent;
    if (native.inputType === "insertLineBreak") {
      e.preventDefault();
      triggerSoftKey("enter");
    }
  };

  const handleMobileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (!value) return;
    // Process each inserted character cleanly and reset immediately so autocorrect never interferes
    for (const ch of value) {
      triggerSoftKey(ch);
    }
    e.target.value = "";
  };

  // Multi-touch & mouse pointer handlers
  const handlePointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    keyData: PianoKeyDef,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.currentTarget.setPointerCapture) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if capture is unsupported
      }
    }
    activePointersRef.current.set(e.pointerId, keyData.note);
    syncVisualPressed();
    triggerNoteDown(keyData.note, keyData.frequency);
  };

  const handlePointerRelease = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const heldNote = activePointersRef.current.get(e.pointerId);
    if (!heldNote) return;
    if (e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
    }
    activePointersRef.current.delete(e.pointerId);
    syncVisualPressed();
    triggerNoteUp(heldNote);
  };

  const preventKeyFocusScroll = (e: React.SyntheticEvent) => {
    e.preventDefault();
  };

  const getBlackKeyLeftPct = (keyData: PianoKeyDef) => {
    const fineOffset =
      keyData.baseName === "C#" || keyData.baseName === "F#"
        ? 0.94
        : keyData.baseName === "D#" || keyData.baseName === "A#"
          ? 1.06
          : 1.0;
    return (keyData.position + fineOffset) * WHITE_KEY_PCT - BLACK_KEY_PCT / 2;
  };

  const isPressed = (note: string) =>
    pressedNotes.has(note) || Boolean(externalActiveNotes?.has(note));

  const scrollToOctave = (which: "low" | "high") => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({
      left: which === "low" ? 0 : scrollRef.current.scrollWidth,
      behavior: "smooth",
    });
  };

  const lowOctNum = 4 + octaveOffset;
  const highOctNum = 5 + octaveOffset;

  return (
    <div className="relative w-full space-y-3">
      {/* Hidden accessible input positioned at the top of the piano so mobile OS focus never forces page scrolling */}
      <input
        id="piano-device-keyboard"
        ref={mobileInputRef}
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="send"
        aria-label="Play piano with device keyboard"
        data-piano-keyboard-input="true"
        onBeforeInput={handleMobileBeforeInput}
        onChange={handleMobileInput}
        onFocus={() => onKeyboardActiveChange?.(true)}
        onBlur={() => onKeyboardActiveChange?.(false)}
        className="pointer-events-none absolute top-0 left-0 h-px w-px text-[16px] opacity-0"
      />

      {/* Quick Mobile Octave Scroll Controls */}
      <div className="flex items-center justify-between gap-2 md:hidden">
        <button
          type="button"
          onClick={() => scrollToOctave("low")}
          className="rounded-lg border border-border bg-muted/70 px-3 py-1.5 text-xs font-semibold text-foreground transition hover:border-primary/50 hover:text-primary cursor-pointer"
        >
          ← Octave C{lowOctNum}–B{lowOctNum}
        </button>
        <span className="text-[11px] text-muted-foreground">Jump octave ↔</span>
        <button
          type="button"
          onClick={() => scrollToOctave("high")}
          className="rounded-lg border border-border bg-muted/70 px-3 py-1.5 text-xs font-semibold text-foreground transition hover:border-primary/50 hover:text-primary cursor-pointer"
        >
          Octave C{highOctNum}–B{highOctNum} →
        </button>
      </div>

      {/* Physical 3D Keybed Chassis */}
      <div className="piano-chassis w-full">
        <div className="piano-felt-strip" aria-hidden="true" />

        <div ref={scrollRef} className="piano-scroll w-full overflow-x-auto overflow-y-hidden pb-3">
          <div
            ref={keybedRef}
            className="piano-keybed relative mx-auto h-[196px] min-w-[680px] w-full sm:h-[228px] lg:h-[252px]"
            onMouseDown={preventKeyFocusScroll}
            onContextMenu={preventKeyFocusScroll}
          >
            {/* 3D White Keys */}
            <div className="flex h-full w-full gap-[2px]">
              {whiteKeys.map((keyData) => {
                const active = isPressed(keyData.note);
                return (
                  <button
                    key={keyData.note}
                    type="button"
                    tabIndex={-1}
                    aria-label={`Piano key ${keyData.note} (${keyData.displayKey})`}
                    aria-pressed={active}
                    data-pressed={active ? "true" : "false"}
                    className="piano-key-white h-full flex-1"
                    onMouseDown={preventKeyFocusScroll}
                    onClick={preventKeyFocusScroll}
                    onPointerDown={(e) => handlePointerDown(e, keyData)}
                    onPointerUp={handlePointerRelease}
                    onPointerCancel={handlePointerRelease}
                    onLostPointerCapture={handlePointerRelease}
                  >
                    <span
                      aria-hidden="true"
                      className={`mb-auto mt-3 size-1.5 rounded-full transition-all duration-100 ${
                        active
                          ? "scale-125 bg-gradient-to-r from-[#dc2626] to-[#f97316] shadow-[0_0_8px_#ea580c]"
                          : "bg-transparent"
                      }`}
                    />

                    {showLabels && (
                      <div className="pointer-events-none flex flex-col items-center gap-1">
                        <span
                          className={`text-[11px] font-bold tracking-tight transition-colors ${
                            active ? "text-[#b91c1c]" : "text-stone-600"
                          }`}
                        >
                          {keyData.note}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold transition-colors ${
                            active
                              ? "bg-gradient-to-r from-[#dc2626] to-[#ea580c] text-white shadow-xs"
                              : "bg-stone-200/90 text-stone-700"
                          }`}
                        >
                          {keyData.displayKey}
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 3D Black Keys */}
            {blackKeys.map((keyData) => {
              const active = isPressed(keyData.note);
              return (
                <button
                  key={keyData.note}
                  type="button"
                  tabIndex={-1}
                  aria-label={`Piano key ${keyData.note} (${keyData.displayKey})`}
                  aria-pressed={active}
                  data-pressed={active ? "true" : "false"}
                  className="piano-key-black z-20"
                  style={{
                    left: `${getBlackKeyLeftPct(keyData)}%`,
                    width: `${BLACK_KEY_PCT}%`,
                    height: "61%",
                  }}
                  onMouseDown={preventKeyFocusScroll}
                  onClick={preventKeyFocusScroll}
                  onPointerDown={(e) => handlePointerDown(e, keyData)}
                  onPointerUp={handlePointerRelease}
                  onPointerCancel={handlePointerRelease}
                  onLostPointerCapture={handlePointerRelease}
                >
                  {showLabels && (
                    <div className="pointer-events-none relative z-10 flex flex-col items-center gap-1">
                      <span
                        className={`text-[9px] font-semibold tracking-tight ${
                          active ? "text-orange-100" : "text-stone-400"
                        }`}
                      >
                        {keyData.baseName}
                      </span>
                      <span
                        className={`rounded px-1 py-0.5 font-mono text-[10px] font-semibold ${
                          active ? "bg-white/20 text-white" : "bg-white/10 text-stone-200"
                        }`}
                      >
                        {keyData.displayKey}
                      </span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Mobile / Tablet Built-In Keyboard Status Banner (placed below keybed so toggling never shifts keys vertically) */}
      {keyboardActive && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-orange-500/35 bg-gradient-to-r from-[#dc2626]/10 via-[#ea580c]/10 to-[#f97316]/10 px-3.5 py-2 text-xs font-medium text-foreground">
          <span className="flex items-center gap-2">
            <Keyboard className="size-4 shrink-0 text-primary" />
            <span>
              <strong>Device Keyboard Active:</strong> Type keys (A–J, W–U, K–C),{" "}
              <kbd className="rounded bg-card px-1 py-0.5 font-mono text-[11px] ring-1 ring-border">
                Space
              </kbd>{" "}
              for Sustain,{" "}
              <kbd className="rounded bg-card px-1 py-0.5 font-mono text-[11px] ring-1 ring-border">
                -
              </kbd>
              /
              <kbd className="rounded bg-card px-1 py-0.5 font-mono text-[11px] ring-1 ring-border">
                +
              </kbd>{" "}
              for Octave,{" "}
              <kbd className="rounded bg-card px-1 py-0.5 font-mono text-[11px] ring-1 ring-border">
                1
              </kbd>
              /
              <kbd className="rounded bg-card px-1 py-0.5 font-mono text-[11px] ring-1 ring-border">
                2
              </kbd>{" "}
              for Mode.
            </span>
          </span>
          <button
            type="button"
            onClick={() => onKeyboardActiveChange?.(false)}
            className="rounded-md bg-card px-2.5 py-1 text-[11px] font-semibold text-primary ring-1 ring-border hover:bg-accent cursor-pointer"
          >
            Hide Keyboard
          </button>
        </div>
      )}
    </div>
  );
};

export default Piano;

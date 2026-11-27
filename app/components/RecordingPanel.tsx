import React, { useEffect, useRef, useState } from "react";
import {
  Circle,
  Clock,
  Download,
  HardDrive,
  Pause,
  Play,
  Save,
  Trash2,
  AudioLines,
  ShieldCheck,
} from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import {
  formatRemainingTime,
  getValidRecording,
  type StoredRecording,
} from "../lib/recordingStorage";
import { formatDuration, formatFileSize } from "../lib/wavEncoder";

export interface RecordingStatusMessage {
  type: "info" | "success" | "error";
  text: string;
}

interface RecordingPanelProps {
  recordingEnabled: boolean;
  hasCapturedAudio: boolean;
  elapsedSeconds: number;
  recordings: StoredRecording[];
  storageSupported: boolean;
  statusMessage: RecordingStatusMessage | null;
  onToggleRecording: () => void;
  onSaveTakeNow: () => void;
  onDeleteRecording: (id: string) => void;
  onClearAll: () => void;
  onRecordingsExpired: () => void;
}

const RecordingPanel: React.FC<RecordingPanelProps> = ({
  recordingEnabled,
  hasCapturedAudio,
  elapsedSeconds,
  recordings,
  storageSupported,
  statusMessage,
  onToggleRecording,
  onSaveTakeNow,
  onDeleteRecording,
  onClearAll,
  onRecordingsExpired,
}) => {
  const [now, setNow] = useState(() => Date.now());
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [playCurrentTime, setPlayCurrentTime] = useState(0);
  const [playDuration, setPlayDuration] = useState(0);

  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const activeUrlRef = useRef<string | null>(null);
  const onExpiredRef = useRef(onRecordingsExpired);
  onExpiredRef.current = onRecordingsExpired;

  const stopPlayback = () => {
    const audio = audioElRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (activeUrlRef.current) {
      URL.revokeObjectURL(activeUrlRef.current);
      activeUrlRef.current = null;
    }
    setPlayingId(null);
    setIsPaused(false);
    setPlayCurrentTime(0);
    setPlayDuration(0);
  };

  // Cleanup audio element and object URL on unmount
  useEffect(() => {
    return () => {
      if (audioElRef.current) {
        audioElRef.current.pause();
        audioElRef.current.removeAttribute("src");
      }
      if (activeUrlRef.current) {
        URL.revokeObjectURL(activeUrlRef.current);
        activeUrlRef.current = null;
      }
    };
  }, []);

  // Stop playback if currently playing item is deleted or expires from list
  useEffect(() => {
    if (playingId && !recordings.some((r) => r.id === playingId)) {
      stopPlayback();
    }
  }, [recordings, playingId]);

  // 1-second live validity countdown & automatic expiration trigger
  useEffect(() => {
    if (recordings.length === 0) return;

    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      const anyExpired = recordings.some((r) => r.expiresAt <= current);
      if (anyExpired) {
        onExpiredRef.current();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [recordings]);

  const handleTogglePlay = async (rec: StoredRecording) => {
    // Toggle pause/resume on already loaded recording
    if (playingId === rec.id && audioElRef.current) {
      if (audioElRef.current.paused) {
        if (rec.expiresAt <= Date.now()) {
          stopPlayback();
          onRecordingsExpired();
          return;
        }
        try {
          await audioElRef.current.play();
          setIsPaused(false);
        } catch {
          stopPlayback();
        }
      } else {
        audioElRef.current.pause();
        setIsPaused(true);
      }
      return;
    }

    // Verify validity directly in IndexedDB before starting playback
    const validRecord = await getValidRecording(rec.id);
    if (!validRecord) {
      stopPlayback();
      onRecordingsExpired();
      return;
    }

    stopPlayback();

    const objectUrl = URL.createObjectURL(validRecord.blob);
    activeUrlRef.current = objectUrl;

    const audio = new Audio(objectUrl);
    audioElRef.current = audio;

    audio.onloadedmetadata = () => {
      setPlayDuration(
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : validRecord.durationSec,
      );
    };
    audio.ontimeupdate = () => {
      setPlayCurrentTime(audio.currentTime);
    };
    audio.onended = () => {
      stopPlayback();
    };
    audio.onerror = () => {
      stopPlayback();
    };

    setPlayingId(validRecord.id);
    setIsPaused(false);
    setPlayCurrentTime(0);
    setPlayDuration(validRecord.durationSec);

    try {
      await audio.play();
    } catch {
      stopPlayback();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetTime = Number(e.target.value);
    if (audioElRef.current && Number.isFinite(targetTime)) {
      audioElRef.current.currentTime = targetTime;
      setPlayCurrentTime(targetTime);
    }
  };

  const handleDownload = async (rec: StoredRecording) => {
    const validRecord = await getValidRecording(rec.id);
    if (!validRecord) {
      onRecordingsExpired();
      return;
    }

    const url = URL.createObjectURL(validRecord.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = validRecord.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const handleDelete = (id: string) => {
    if (playingId === id) {
      stopPlayback();
    }
    onDeleteRecording(id);
  };

  const handleClearAllClick = () => {
    stopPlayback();
    onClearAll();
  };

  return (
    <Card className="border-border/90 bg-card shadow-sm transition-colors duration-300">
      <CardHeader className="gap-3 border-b border-border/70 pb-5">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg font-bold sm:text-xl">
              <AudioLines className="size-5 text-primary" />
              Local Audio Recorder
              <span className="rounded-md bg-gradient-to-r from-[#dc2626]/12 to-[#f97316]/12 px-2 py-0.5 font-mono text-[11px] font-bold text-red-700 ring-1 ring-red-500/25 dark:text-orange-300">
                .WAV
              </span>
            </CardTitle>
            <CardDescription className="mt-1 text-xs sm:text-sm">
              Enable recording to capture studio audio as genuine 16-bit stereo .WAV files stored
              locally in your browser for 30 minutes.
            </CardDescription>
          </div>

          {/* Primary Recording Toggle Switch & Save Take Action */}
          <div className="flex flex-wrap items-center gap-2.5">
            {recordingEnabled && hasCapturedAudio && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSaveTakeNow}
                className="studio-panel-in border-orange-500/40 text-orange-700 hover:bg-orange-500/10 dark:text-orange-300"
                title="Save the current recording as a .WAV file and keep recording enabled"
              >
                <Save className="size-3.5" />
                Save .WAV
              </Button>
            )}

            <button
              type="button"
              role="switch"
              aria-checked={recordingEnabled}
              aria-label={recordingEnabled ? "Disable audio recording" : "Enable audio recording"}
              disabled={!storageSupported}
              onClick={onToggleRecording}
              className={`group inline-flex h-9.5 items-center gap-2.5 rounded-full border px-3.5 text-xs font-semibold transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                recordingEnabled
                  ? "border-red-500/50 bg-gradient-to-r from-[#dc2626] via-[#ea580c] to-[#f97316] text-white shadow-[0_6px_18px_-4px_rgba(220,38,38,0.55)]"
                  : "border-border bg-muted/70 text-foreground hover:border-primary/50 hover:bg-accent"
              }`}
            >
              <span
                aria-hidden="true"
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ${
                  recordingEnabled ? "bg-black/25" : "bg-border"
                }`}
              >
                <span
                  className={`size-4 rounded-full bg-white shadow-xs transition-transform duration-200 ease-out ${
                    recordingEnabled ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </span>
              <span>{recordingEnabled ? "Recording ON" : "Enable Recording"}</span>
            </button>
          </div>
        </div>

        {/* Live Recording Status + Local Storage & 30-Minute Policy Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            {recordingEnabled ? (
              <span className="studio-panel-in inline-flex items-center gap-2 rounded-full border border-red-500/35 bg-red-500/10 px-3 py-1 font-semibold text-red-700 dark:text-red-300">
                <span className="relative flex size-2.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-red-600" />
                </span>
                {hasCapturedAudio ? (
                  <>
                    <span>Capturing Audio</span>
                    <span className="font-mono font-bold">
                      {formatDuration(elapsedSeconds)}
                    </span>
                  </>
                ) : (
                  <span>Armed — Play any key to capture audio</span>
                )}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 py-1 font-medium text-muted-foreground">
                <Circle className="size-2.5 fill-muted-foreground/50 text-muted-foreground/50" />
                Recording Disabled — No audio is captured or stored
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="size-3.5 text-orange-600 dark:text-orange-400" />
              Local Browser Only (IndexedDB)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="size-3.5 text-red-600 dark:text-red-400" />
              Auto-deletes after 30 min
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-1">
        {/* Inline Feedback Banner */}
        {statusMessage && (
          <div
            role="status"
            aria-live="polite"
            className={`studio-panel-in rounded-xl border px-3.5 py-2.5 text-xs font-medium sm:text-sm ${
              statusMessage.type === "error"
                ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
                : statusMessage.type === "success"
                  ? "border-orange-500/35 bg-gradient-to-r from-[#dc2626]/10 via-[#ea580c]/10 to-[#f97316]/10 text-foreground"
                  : "border-border bg-muted/50 text-muted-foreground"
            }`}
          >
            {statusMessage.text}
          </div>
        )}

        {/* Saved Recordings Header & List */}
        {recordings.length > 0 ? (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                <HardDrive className="size-3.5 text-primary" />
                Saved Local Recordings ({recordings.length})
              </span>
              {recordings.length > 1 && (
                <button
                  type="button"
                  onClick={handleClearAllClick}
                  className="text-xs font-semibold text-destructive transition-opacity hover:opacity-80 cursor-pointer"
                >
                  Delete All
                </button>
              )}
            </div>

            <div className="space-y-2.5">
              {recordings.map((rec) => {
                const isActive = playingId === rec.id;
                const isPlayingNow = isActive && !isPaused;
                const remainingMs = Math.max(0, rec.expiresAt - now);
                const expiringSoon = remainingMs <= 5 * 60 * 1000;
                const activeDuration = isActive && playDuration > 0 ? playDuration : rec.durationSec;

                return (
                  <div
                    key={rec.id}
                    className={`studio-panel-in flex flex-col gap-3 rounded-xl border p-3.5 transition-all duration-200 ${
                      isActive
                        ? "border-primary/50 bg-gradient-to-r from-[#dc2626]/[0.05] via-[#ea580c]/[0.05] to-[#f97316]/[0.05] shadow-xs"
                        : "border-border bg-muted/35 hover:border-primary/35"
                    }`}
                  >
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                      <div className="flex min-w-0 items-center gap-3">
                        <button
                          type="button"
                          onClick={() => handleTogglePlay(rec)}
                          aria-label={isPlayingNow ? `Pause ${rec.name}` : `Play ${rec.name}`}
                          className="flex size-9.5 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-[#dc2626] via-[#ea580c] to-[#f97316] text-white shadow-[0_4px_14px_-3px_rgba(234,88,12,0.55)] transition-transform duration-150 hover:scale-105 active:scale-95 cursor-pointer"
                        >
                          {isPlayingNow ? (
                            <Pause className="size-4 fill-current" />
                          ) : (
                            <Play className="ml-0.5 size-4 fill-current" />
                          )}
                        </button>

                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-foreground">
                              {rec.name}
                            </p>
                            <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10px] font-bold text-primary ring-1 ring-border">
                              WAV · {Math.round(rec.sampleRate / 1000)}kHz
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span className="font-mono">{formatDuration(rec.durationSec)}</span>
                            <span>{formatFileSize(rec.sizeBytes)}</span>
                            <span
                              className={`inline-flex items-center gap-1 font-medium ${
                                expiringSoon
                                  ? "text-red-600 dark:text-red-400"
                                  : "text-orange-700 dark:text-orange-300"
                              }`}
                            >
                              <Clock className="size-3" />
                              {formatRemainingTime(rec.expiresAt, now)}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleDownload(rec)}
                          title={`Download ${rec.fileName}`}
                        >
                          <Download className="size-3.5 text-orange-600 dark:text-orange-400" />
                          <span>.WAV</span>
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => handleDelete(rec.id)}
                          aria-label={`Delete ${rec.name}`}
                          title="Delete recording from local storage"
                          className="size-8.5 border-border text-muted-foreground hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Interactive Playback Scrubber (visible when active) */}
                    {isActive && (
                      <div className="studio-panel-in flex items-center gap-2.5 pt-0.5">
                        <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground">
                          {formatDuration(playCurrentTime)}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0.1, activeDuration)}
                          step={0.05}
                          value={Math.min(playCurrentTime, activeDuration)}
                          onChange={handleSeek}
                          aria-label={`Seek ${rec.name}`}
                          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary"
                        />
                        <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                          {formatDuration(activeDuration)}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-muted/25 px-4 py-5 text-center text-xs text-muted-foreground sm:text-sm">
            {recordingEnabled
              ? "Recording is enabled. Play notes on the piano or synthesizer, then click Save .WAV or toggle recording off to store your recording locally."
              : "No active local recordings. Toggle Enable Recording above to capture and store genuine .WAV audio locally for 30 minutes."}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default RecordingPanel;

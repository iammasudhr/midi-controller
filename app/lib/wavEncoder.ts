/**
 * Pure client-side RIFF/WAVE (16-bit stereo PCM) audio encoder.
 * Produces genuine, standards-compliant .wav files playable in all browsers,
 * OS media players, and DAWs without any external dependencies or uploads.
 */

export interface EncodedWavResult {
  blob: Blob;
  durationSec: number;
  sampleRate: number;
  sizeBytes: number;
  peakAmplitude: number;
}

function writeAsciiString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function encodeStereoWav(
  leftChunks: Float32Array[],
  rightChunks: Float32Array[],
  sampleRate: number,
): EncodedWavResult {
  const numChannels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;

  let totalFrames = 0;
  for (let i = 0; i < leftChunks.length; i++) {
    totalFrames += leftChunks[i].length;
  }

  const dataByteLength = totalFrames * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeAsciiString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeAsciiString(view, 8, "WAVE");

  // fmt sub-chunk (Linear PCM)
  writeAsciiString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size for PCM
  view.setUint16(20, 1, true); // AudioFormat = 1 (Linear PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
  view.setUint16(32, numChannels * bytesPerSample, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeAsciiString(view, 36, "data");
  view.setUint32(40, dataByteLength, true);

  // Interleave stereo Float32 [-1, 1] -> signed 16-bit little-endian PCM
  let offset = 44;
  let peakAmplitude = 0;

  for (let c = 0; c < leftChunks.length; c++) {
    const left = leftChunks[c];
    const right = rightChunks[c] ?? left;
    const len = left.length;

    for (let i = 0; i < len; i++) {
      const lRaw = left[i] ?? 0;
      const rRaw = right[i] ?? lRaw;

      const lClamped = Math.max(-1, Math.min(1, lRaw));
      const rClamped = Math.max(-1, Math.min(1, rRaw));

      const absMax = Math.max(Math.abs(lClamped), Math.abs(rClamped));
      if (absMax > peakAmplitude) {
        peakAmplitude = absMax;
      }

      const lInt = lClamped < 0 ? Math.round(lClamped * 0x8000) : Math.round(lClamped * 0x7fff);
      const rInt = rClamped < 0 ? Math.round(rClamped * 0x8000) : Math.round(rClamped * 0x7fff);

      view.setInt16(offset, lInt, true);
      view.setInt16(offset + 2, rInt, true);
      offset += 4;
    }
  }

  const blob = new Blob([buffer], { type: "audio/wav" });
  return {
    blob,
    durationSec: sampleRate > 0 ? totalFrames / sampleRate : 0,
    sampleRate,
    sizeBytes: blob.size,
    peakAmplitude,
  };
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

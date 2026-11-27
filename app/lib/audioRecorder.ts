import { encodeStereoWav, type EncodedWavResult } from "./wavEncoder";

/**
 * High-precision Web Audio stereo PCM recorder.
 * Taps directly off the studio master output node (post-reverb, post-limiter)
 * using AudioWorkletNode with graceful ScriptProcessorNode fallback.
 *
 * When recording is disabled, zero audio samples are retained in memory.
 */

const WORKLET_PROCESSOR_NAME = "studio-pcm-recorder-processor";
const MAX_SINGLE_TAKE_SECONDS = 300; // Auto-roll after 5 min continuous recording to protect RAM

const WORKLET_SOURCE = `
class StudioPcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.active === "boolean") {
        this.active = event.data.active;
      }
    };
  }

  process(inputs) {
    if (!this.active) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;
    const ch1 = input[1] || ch0;
    const leftCopy = new Float32Array(ch0.length);
    const rightCopy = new Float32Array(ch1.length);
    leftCopy.set(ch0);
    rightCopy.set(ch1);
    this.port.postMessage({ left: leftCopy, right: rightCopy }, [leftCopy.buffer, rightCopy.buffer]);
    return true;
  }
}
registerProcessor("${WORKLET_PROCESSOR_NAME}", StudioPcmRecorderProcessor);
`;

export interface RecorderCallbacks {
  onAutoSplit?: (wav: EncodedWavResult) => void;
  onSignalDetected?: () => void;
}

export class StudioAudioRecorder {
  private ctx: AudioContext | null = null;
  private sourceNode: AudioNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private silentSink: GainNode | null = null;
  private workletReady = false;
  private workletLoading: Promise<void> | null = null;

  private isRecording = false;
  private leftChunks: Float32Array[] = [];
  private rightChunks: Float32Array[] = [];
  private preRollLeft: Float32Array | null = null;
  private preRollRight: Float32Array | null = null;
  private capturedFrames = 0;
  private signalDetected = false;
  private callbacks: RecorderCallbacks = {};

  constructor(callbacks?: RecorderCallbacks) {
    if (callbacks) {
      this.callbacks = callbacks;
    }
  }

  setCallbacks(callbacks: RecorderCallbacks) {
    this.callbacks = callbacks;
  }

  async attach(ctx: AudioContext, sourceNode: AudioNode): Promise<void> {
    if (this.ctx === ctx && this.sourceNode === sourceNode && (this.workletNode || this.scriptNode)) {
      return;
    }

    this.detachNodes();
    this.ctx = ctx;
    this.sourceNode = sourceNode;

    // Silent sink keeps AudioWorkletNode / ScriptProcessorNode pulled without doubling output audio
    const sink = ctx.createGain();
    sink.gain.setValueAtTime(0, ctx.currentTime);
    sink.connect(ctx.destination);
    this.silentSink = sink;

    if (typeof AudioWorkletNode !== "undefined" && ctx.audioWorklet) {
      try {
        if (!this.workletReady) {
          if (!this.workletLoading) {
            const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
            const url = URL.createObjectURL(blob);
            this.workletLoading = ctx.audioWorklet
              .addModule(url)
              .then(() => {
                this.workletReady = true;
              })
              .finally(() => {
                URL.revokeObjectURL(url);
                this.workletLoading = null;
              });
          }
          await this.workletLoading;
        }

        if (this.ctx !== ctx) return; // Context changed while loading

        const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 2,
          outputChannelCount: [2],
        });

        node.port.onmessage = (event: MessageEvent<{ left: Float32Array; right: Float32Array }>) => {
          if (!this.isRecording || !event.data) return;
          this.pushStereoChunk(event.data.left, event.data.right);
        };

        sourceNode.connect(node);
        node.connect(sink);
        this.workletNode = node;
        node.port.postMessage({ active: this.isRecording });
        return;
      } catch {
        // Fall through cleanly to ScriptProcessorNode fallback
      }
    }

    // Fallback for environments where AudioWorklet is unavailable (e.g. non-HTTPS LAN IP)
    if (typeof ctx.createScriptProcessor === "function") {
      const processor = ctx.createScriptProcessor(4096, 2, 2);
      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!this.isRecording) return;
        const input = event.inputBuffer;
        const left = new Float32Array(input.getChannelData(0));
        const right =
          input.numberOfChannels > 1
            ? new Float32Array(input.getChannelData(1))
            : new Float32Array(left);
        this.pushStereoChunk(left, right);
      };
      sourceNode.connect(processor);
      processor.connect(sink);
      this.scriptNode = processor;
    }
  }

  private pushStereoChunk(left: Float32Array, right: Float32Array) {
    if (!this.signalDetected) {
      let heardAudio = false;
      for (let i = 0; i < left.length; i += 4) {
        if (Math.abs(left[i]) > 0.0004 || Math.abs(right[i]) > 0.0004) {
          heardAudio = true;
          break;
        }
      }

      if (!heardAudio) {
        // Keep only the most recent chunk as a tiny pre-roll so the first attack transient is never clipped
        this.preRollLeft = left;
        this.preRollRight = right;
        return;
      }

      this.signalDetected = true;
      if (this.preRollLeft && this.preRollRight) {
        this.leftChunks.push(this.preRollLeft);
        this.rightChunks.push(this.preRollRight);
        this.capturedFrames += this.preRollLeft.length;
        this.preRollLeft = null;
        this.preRollRight = null;
      }
      this.callbacks.onSignalDetected?.();
    }

    this.leftChunks.push(left);
    this.rightChunks.push(right);
    this.capturedFrames += left.length;

    const sampleRate = this.ctx?.sampleRate || 44100;
    if (this.capturedFrames >= sampleRate * MAX_SINGLE_TAKE_SECONDS) {
      const wav = this.flushCurrentTake();
      if (wav && wav.peakAmplitude > 0.0004) {
        this.callbacks.onAutoSplit?.(wav);
      }
    }
  }

  start() {
    this.clearBuffers();
    this.isRecording = true;
    this.workletNode?.port.postMessage({ active: true });
  }

  /**
   * Stops capture, encodes captured PCM into a genuine .wav Blob if audible audio was captured,
   * and releases all in-memory PCM buffers immediately.
   */
  stopAndEncode(): EncodedWavResult | null {
    this.isRecording = false;
    this.workletNode?.port.postMessage({ active: false });
    return this.flushCurrentTake();
  }

  /**
   * Encodes the current captured take into a .wav Blob and resets buffers
   * while keeping recording active for the next take.
   */
  saveTakeAndContinue(): EncodedWavResult | null {
    if (!this.isRecording) return null;
    return this.flushCurrentTake();
  }

  discard() {
    this.isRecording = false;
    this.workletNode?.port.postMessage({ active: false });
    this.clearBuffers();
  }

  get active(): boolean {
    return this.isRecording;
  }

  get hasAudioSignal(): boolean {
    return this.signalDetected;
  }

  get elapsedSeconds(): number {
    if (!this.isRecording || !this.ctx) return 0;
    return this.capturedFrames / (this.ctx.sampleRate || 44100);
  }

  private flushCurrentTake(): EncodedWavResult | null {
    if (this.capturedFrames === 0 || this.leftChunks.length === 0) {
      this.clearBuffers();
      return null;
    }

    const left = this.leftChunks;
    const right = this.rightChunks;
    const sampleRate = this.ctx?.sampleRate || 44100;
    this.clearBuffers();

    return encodeStereoWav(left, right, sampleRate);
  }

  private clearBuffers() {
    this.leftChunks = [];
    this.rightChunks = [];
    this.preRollLeft = null;
    this.preRollRight = null;
    this.capturedFrames = 0;
    this.signalDetected = false;
  }

  private detachNodes() {
    try {
      if (this.sourceNode && this.workletNode) {
        this.sourceNode.disconnect(this.workletNode);
      }
    } catch {
      // Ignore disconnect errors
    }
    try {
      this.workletNode?.disconnect();
    } catch {
      // Ignore
    }
    try {
      if (this.sourceNode && this.scriptNode) {
        this.sourceNode.disconnect(this.scriptNode);
      }
    } catch {
      // Ignore
    }
    try {
      this.scriptNode?.disconnect();
    } catch {
      // Ignore
    }
    try {
      this.silentSink?.disconnect();
    } catch {
      // Ignore
    }
    this.workletNode = null;
    this.scriptNode = null;
    this.silentSink = null;
  }

  dispose() {
    this.discard();
    this.detachNodes();
    this.ctx = null;
    this.sourceNode = null;
    this.workletReady = false;
    this.workletLoading = null;
  }
}

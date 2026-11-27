export interface PianoNoteNodes {
  oscillators: OscillatorNode[];
  gainNode: GainNode;
  noiseNode?: AudioBufferSourceNode;
}

export interface SynthEnvelopeSettings {
  volume: number;
  attack: number;
  release: number;
}

export class PianoSynthesizer {
  private audioContext: AudioContext;
  private destination: AudioNode;
  private settings: SynthEnvelopeSettings;

  constructor(audioContext: AudioContext, destination: AudioNode) {
    this.audioContext = audioContext;
    this.destination = destination;
    this.settings = {
      volume: 0.7,
      attack: 0.015,
      release: 1.4,
    };
  }

  updateSettings(settings: SynthEnvelopeSettings) {
    this.settings = { ...settings };
  }

  createPianoSound(frequency: number, velocity = 0.85): PianoNoteNodes {
    const now = this.audioContext.currentTime;
    const attack = Math.max(0.005, this.settings.attack);
    const peakGain = Math.max(0.001, Math.min(1, velocity) * 0.55);
    const sustainGain = Math.max(0.0005, peakGain * 0.62);

    const noteGain = this.audioContext.createGain();
    const oscillators: OscillatorNode[] = [];

    // Harmonic series for warm acoustic grand-piano timbre
    const partials: Array<{ ratio: number; type: OscillatorType; gain: number }> = [
      { ratio: 1, type: "triangle", gain: 0.78 },
      { ratio: 2, type: "triangle", gain: 0.28 },
      { ratio: 3, type: "sine", gain: 0.14 },
      { ratio: 4, type: "sine", gain: 0.07 },
      { ratio: 1.0018, type: "triangle", gain: 0.18 }, // Subtle unison chorus
    ];

    partials.forEach(({ ratio, type, gain }) => {
      const osc = this.audioContext.createOscillator();
      osc.frequency.setValueAtTime(frequency * ratio, now);
      osc.type = type;

      const partialGain = this.audioContext.createGain();
      partialGain.gain.setValueAtTime(gain, now);

      osc.connect(partialGain);
      partialGain.connect(noteGain);
      oscillators.push(osc);
    });

    // Subtle hammer strike transient for lower & mid keys
    let noiseNode: AudioBufferSourceNode | undefined;
    if (frequency < 1200) {
      const noiseBuffer = this.createNoiseBuffer(0.08);
      noiseNode = this.audioContext.createBufferSource();
      noiseNode.buffer = noiseBuffer;

      const noiseGain = this.audioContext.createGain();
      noiseGain.gain.setValueAtTime(0.06, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

      const noiseFilter = this.audioContext.createBiquadFilter();
      noiseFilter.type = "bandpass";
      noiseFilter.frequency.setValueAtTime(Math.min(frequency * 3.5, 4500), now);
      noiseFilter.Q.setValueAtTime(1.2, now);

      noiseNode.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(noteGain);
    }

    // Smooth click-free envelope (attack -> natural initial piano decay)
    noteGain.gain.setValueAtTime(0.0001, now);
    noteGain.gain.linearRampToValueAtTime(peakGain, now + attack);
    noteGain.gain.exponentialRampToValueAtTime(sustainGain, now + attack + 0.14);

    noteGain.connect(this.destination);

    oscillators.forEach((osc) => {
      try {
        osc.start(now);
      } catch {
        // Ignore start failures if context is closing
      }
    });

    if (noiseNode) {
      try {
        noiseNode.start(now);
      } catch {
        // Ignore transient start failures
      }
    }

    return { oscillators, gainNode: noteGain, noiseNode };
  }

  stopPianoSound(nodes: PianoNoteNodes, immediate = false) {
    const now = this.audioContext.currentTime;
    const { oscillators, gainNode, noiseNode } = nodes;
    const effectiveRelease = immediate
      ? 0.03
      : Math.max(0.02, Math.min(this.settings.release, 3.0));

    try {
      const currentGain = Math.max(0.0001, gainNode.gain.value);
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(currentGain, now);

      if (effectiveRelease < 0.08) {
        gainNode.gain.linearRampToValueAtTime(0.0001, now + effectiveRelease);
      } else {
        gainNode.gain.exponentialRampToValueAtTime(0.0001, now + effectiveRelease);
      }

      const stopTime = now + effectiveRelease + 0.04;
      oscillators.forEach((osc) => {
        try {
          osc.stop(stopTime);
        } catch {
          // Already stopped
        }
      });

      if (noiseNode) {
        try {
          noiseNode.stop(now + 0.08);
        } catch {
          // Already stopped
        }
      }

      window.setTimeout(() => {
        try {
          gainNode.disconnect();
          oscillators.forEach((osc) => {
            try {
              osc.disconnect();
            } catch {
              // Ignore
            }
          });
          if (noiseNode) {
            try {
              noiseNode.disconnect();
            } catch {
              // Ignore
            }
          }
        } catch {
          // Ignore cleanup errors
        }
      }, (effectiveRelease + 0.12) * 1000);
    } catch {
      try {
        gainNode.gain.setValueAtTime(0, now);
        oscillators.forEach((osc) => {
          try {
            osc.stop(now);
            osc.disconnect();
          } catch {
            // Ignore
          }
        });
        gainNode.disconnect();
      } catch {
        // Ignore
      }
    }
  }

  private createNoiseBuffer(duration: number): AudioBuffer {
    const sampleRate = this.audioContext.sampleRate;
    const length = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = this.audioContext.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.14;
    }

    return buffer;
  }
}

export default PianoSynthesizer;

/**
 * The app's sound effects — off by default, per section 84's "sound effects
 * (optional)".
 *
 * # Synthesised, not sampled
 *
 * Every cue here is a couple of oscillators and a gain envelope rather than an
 * audio file. That is a deliberate trade and worth stating, because sampled
 * audio is the obvious choice:
 *
 * - Nothing is added to the installer. Section 85 ships a Windows installer,
 *   and five `.wav` files for a feature that is off by default is weight
 *   every user carries so that a minority can hear a tick.
 * - Nothing has to load. A cue plays on the same tick the checkbox is
 *   clicked, with no fetch, no decode and no cache to be cold on first use —
 *   a sound that arrived 200ms after the tick would be worse than none.
 * - Nothing has a licence. Sampled UI sounds come with attribution terms that
 *   would have to be tracked and shipped.
 *
 * The cost is that these are simple tones. That suits them: section 50 puts
 * gamification below the work, and a fanfare on completing a task would be
 * exactly the kind of thing that ranking exists to prevent.
 *
 * # Volume and register
 *
 * Everything is quiet, short, and sits above the speech range so it reads as
 * an interface noise rather than a notification. Peak gain is well under a
 * tenth of full scale; these are meant to be noticed and then not thought
 * about.
 *
 * # Failing silently, on purpose
 *
 * Audio is decoration over an action that has already happened. A blocked
 * autoplay policy, a machine with no output device, a WebView2 without audio
 * — none of those are worth a toast, and certainly not worth stopping the
 * task from being completed. Everything here swallows its errors.
 */

import { isSoundEnabled } from "@/stores/soundStore";

/** The cues the app can play. Each maps to one voicing in {@link VOICINGS}. */
export type SoundEffect =
  /** A task checkbox going from open to done. The most frequent cue by far. */
  | "task-complete"
  /** A focus session reaching the end of its length (section 20). */
  | "focus-complete"
  /** The break after a session running out (section 34). */
  | "break-over"
  /** A routine finishing its action list (section 32). */
  | "routine-complete"
  /** A routine finishing with at least one action that failed (section 87). */
  | "routine-failed"
  /** Crossing a level boundary, or unlocking one of section 47's six. */
  | "progress-up";

interface Voicing {
  /** Frequencies in Hz, played in sequence. One entry is a single blip. */
  notes: number[];
  /** Seconds each note sounds for. */
  noteSeconds: number;
  /** Peak gain, 0-1. Kept low — see the note on volume above. */
  gain: number;
  type: OscillatorType;
}

/**
 * Rising intervals for good outcomes, a falling minor second for the one bad
 * one, which is about as close to a universal convention as UI audio has.
 */
const VOICINGS: Record<SoundEffect, Voicing> = {
  // A single soft blip: this fires every time a task is ticked off, so it has
  // to survive being heard fifty times in a day.
  "task-complete": { notes: [880], noteSeconds: 0.07, gain: 0.05, type: "sine" },

  // Rarer and more consequential, so it gets a two-note figure — and it may
  // arrive when the user has looked away from the screen, which is the one
  // case in this app where a sound is doing real work rather than decorating.
  "focus-complete": { notes: [660, 880, 1320], noteSeconds: 0.11, gain: 0.07, type: "sine" },

  // The same job — the user is, by design, away from the screen — so the same
  // weight, but a different figure: two notes a fourth apart, softer-edged,
  // so "back to work" is not mistaken for "done" by someone not looking.
  "break-over": { notes: [587.33, 783.99], noteSeconds: 0.14, gain: 0.07, type: "triangle" },

  "routine-complete": { notes: [587.33, 880], noteSeconds: 0.08, gain: 0.05, type: "triangle" },

  // Down a semitone, and the only cue that is not a pure tone. It is a
  // partial failure, not an error — section 87 has the rest of the routine
  // running anyway — so it stays as quiet as the rest.
  "routine-failed": { notes: [440, 415.3], noteSeconds: 0.1, gain: 0.05, type: "triangle" },

  "progress-up": { notes: [523.25, 659.25, 783.99], noteSeconds: 0.09, gain: 0.06, type: "sine" },
};

/**
 * Created on the first sound rather than at startup.
 *
 * A window that never plays anything never opens an audio device, which is
 * the common case given the setting is off by default — and building one
 * eagerly in the widget or launcher window would be pure cost.
 */
let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context) return context;

  try {
    context = new AudioContext();
    return context;
  } catch {
    return null;
  }
}

/**
 * Plays a cue, if sound is on.
 *
 * Callers do not check the setting first — that is the point of it being
 * checked here. A call site reads as "this is the moment a task was
 * completed", which stays true whether or not anything is audible.
 */
export function playSound(effect: SoundEffect): void {
  play(effect, false);
}

/**
 * Plays a cue so the user can hear what they are turning on.
 *
 * The one caller that ignores the setting, because it is the settings row
 * itself — including on the click that enables sound, which happens before
 * the store has been told about it.
 */
export function previewSound(effect: SoundEffect = "task-complete"): void {
  play(effect, true);
}

function play(effect: SoundEffect, force: boolean): void {
  if (!force && !isSoundEnabled()) return;

  const ctx = audioContext();
  if (!ctx) return;

  // A context created before the window has been interacted with starts
  // suspended. Resuming is a promise nobody waits on: if it lands in time the
  // cue is heard, and if it does not, the next one will be.
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});

  const voicing = VOICINGS[effect];

  try {
    voicing.notes.forEach((frequency, index) => {
      const startAt = ctx.currentTime + index * voicing.noteSeconds;
      const endAt = startAt + voicing.noteSeconds;

      const oscillator = ctx.createOscillator();
      oscillator.type = voicing.type;
      oscillator.frequency.setValueAtTime(frequency, startAt);

      // The envelope is the whole difference between a tone and a click. A
      // gain that steps from 0 to full is a discontinuity in the waveform,
      // and it is audible as a pop on both ends of every note.
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(0.0001, startAt);
      envelope.gain.exponentialRampToValueAtTime(voicing.gain, startAt + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, endAt);

      oscillator.connect(envelope).connect(ctx.destination);
      oscillator.start(startAt);
      oscillator.stop(endAt + 0.02);
    });
  } catch {
    // See the note on failing silently at the top of the file.
  }
}

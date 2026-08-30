/**
 * Turning keystrokes into accelerators, and accelerators back into something
 * a person can read (development-plan.md section 28).
 *
 * Section 28 asks for a *configurable* shortcut, and the only sane way to
 * configure one is to press it. So the Settings card records a `keydown` and
 * this is what the recording is worth: a string the backend can hand to the
 * global-shortcut plugin, or a reason why the keys pressed will not do.
 *
 * The accelerator format is the plugin's own — modifier names joined to a key
 * by `+` — with two conventions this file and `services/shortcuts.rs` both
 * keep to, so a binding written by one is read the same way by the other:
 *
 * 1. **Modifiers in `Ctrl`, `Alt`, `Shift`, `Super` order.** The plugin
 *    accepts any order; a fixed one means the stored string, the string shown
 *    in Settings and the string in `DEFAULT_QUICK_LAUNCHER_SHORTCUT` are all
 *    the same string for the same shortcut.
 * 2. **W3C key codes for the key** — `KeyP`, `Digit1`, `Space`, `ArrowUp`.
 *    These are exactly what `KeyboardEvent.code` gives, and exactly what the
 *    plugin's parser takes, so nothing has to be translated in between. What
 *    the *user* sees is [`formatAccelerator`]'s job and nobody else's.
 *
 * The physical-key choice in (2) is deliberate beyond convenience: a global
 * hotkey is a position on the keyboard, not a letter. Recording `event.key`
 * would bind `Ctrl+Alt+;` on a US layout to something else entirely on a
 * German one, on the same physical keys.
 */

/** A recorded keystroke: an accelerator, a refusal, or neither yet. */
export type ShortcutRecording =
  | { status: "recorded"; accelerator: string }
  | { status: "rejected"; reason: string }
  /** Modifiers are down but no key has landed — keep listening. */
  | { status: "pending" }
  /** Escape: the user changed their mind. */
  | { status: "cancelled" };

/**
 * Keys that only ever modify another one.
 *
 * Held on their own they are the user still reaching for the combination, so
 * they leave the recorder listening rather than being taken as the answer.
 */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "AltGraph",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

/**
 * The non-alphanumeric keys the plugin's parser knows, by W3C code.
 *
 * Kept as an explicit list rather than "anything that is not a modifier"
 * because the failure it prevents is silent: an accelerator the plugin cannot
 * parse would be stored, refused at registration, and leave the user with a
 * shortcut that reads correctly in Settings and does nothing.
 */
const NAMED_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Page Up",
  PageDown: "Page Down",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  CapsLock: "Caps Lock",
  NumLock: "Num Lock",
  ScrollLock: "Scroll Lock",
  PrintScreen: "Print Screen",
  Pause: "Pause",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

const LETTER = /^Key([A-Z])$/;
const DIGIT = /^Digit([0-9])$/;
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
const NUMPAD = /^Numpad(.+)$/;

/** How each modifier is written in an accelerator, in the canonical order. */
const MODIFIERS = [
  { token: "Ctrl", label: "Ctrl", held: (event: KeyboardEvent) => event.ctrlKey },
  { token: "Alt", label: "Alt", held: (event: KeyboardEvent) => event.altKey },
  { token: "Shift", label: "Shift", held: (event: KeyboardEvent) => event.shiftKey },
  // "Super" is what the plugin parses; "Win" is what is printed on the key.
  { token: "Super", label: "Win", held: (event: KeyboardEvent) => event.metaKey },
] as const;

/** The modifiers that make a shortcut safe to take from the whole machine. */
const REQUIRED = ["Ctrl", "Alt", "Super"];

/**
 * Reads one `keydown` as a shortcut.
 *
 * Mirrors `parse` in `src-tauri/src/services/shortcuts.rs` — the backend
 * refuses the same things, because it has to: this is a convenience, not the
 * check. Doing it here as well is what turns "that shortcut was rejected"
 * into a sentence the user reads *while pressing the keys*.
 */
export function recordShortcut(event: KeyboardEvent): ShortcutRecording {
  // Escape is how the recorder is backed out of, so it is never recordable.
  // A global hotkey on it would also take the escape key away from every
  // other program, which is its own argument.
  if (event.code === "Escape") return { status: "cancelled" };

  if (MODIFIER_CODES.has(event.code)) return { status: "pending" };

  const modifiers = MODIFIERS.filter((modifier) => modifier.held(event)).map((m) => m.token);

  if (!modifiers.some((token) => REQUIRED.includes(token))) {
    return {
      status: "rejected",
      reason: "Hold Ctrl, Alt or Win as well — without one the shortcut would take that key away from every other program.",
    };
  }

  if (!isBindableKey(event.code)) {
    return { status: "rejected", reason: "That key cannot be part of a global shortcut." };
  }

  return { status: "recorded", accelerator: [...modifiers, event.code].join("+") };
}

/** Whether the plugin's parser would recognise this `KeyboardEvent.code`. */
export function isBindableKey(code: string): boolean {
  return (
    LETTER.test(code) ||
    DIGIT.test(code) ||
    FUNCTION_KEY.test(code) ||
    NUMPAD.test(code) ||
    code in NAMED_KEYS
  );
}

/**
 * `"Ctrl+Alt+Space"` becomes `["Ctrl", "Alt", "Space"]` — one token per key
 * cap, so the caller can draw each in its own `<kbd>`.
 *
 * Unrecognised tokens are passed through rather than dropped. This only ever
 * renders what the backend gave us, and a shortcut shown with a key missing
 * would be worse than one shown with a name nobody expected.
 */
export function formatAccelerator(accelerator: string): string[] {
  return accelerator
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean)
    .map(keyLabel);
}

function keyLabel(token: string): string {
  const modifier = MODIFIERS.find((candidate) => candidate.token === token);
  if (modifier) return modifier.label;

  const letter = LETTER.exec(token);
  if (letter) return letter[1];

  const digit = DIGIT.exec(token);
  if (digit) return digit[1];

  const numpad = NUMPAD.exec(token);
  if (numpad) return `Num ${keyLabel(numpad[1])}`;

  return NAMED_KEYS[token] ?? token;
}

/**
 * The shape of section 84's first-run walkthrough.
 *
 * The steps are the loop from development-plan.md section 90 —
 * TASK → ROUTINE → FOCUS → PROGRESS — walked once, in order, with a welcome
 * in front of it. That order is the point of the tour rather than an
 * arrangement of it: section 90 is explicit that the product is not a to-do
 * list, not a timer and not a launcher, but the *connection* between them,
 * and a walkthrough that toured the sidebar instead would teach the three
 * saturated products rather than the one it is.
 *
 * Only the metadata lives here — the ids, the headings, the counter — so that
 * the store can move through the list, and Settings can say how long it is,
 * without importing a screenful of JSX. `OnboardingDialog` owns each step's
 * body and is the only thing that needs to know what a `kind` looks like.
 */

/** The five steps, in the order they are shown. */
export const ONBOARDING_STEP_IDS = ["welcome", "task", "routine", "focus", "progress"] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export interface OnboardingStep {
  id: OnboardingStepId;
  /** The dialog's title on this step. */
  title: string;
  /** One line under the title, before the body. */
  summary: string;
  /**
   * Whether the step asks the user to make something.
   *
   * The two that do are the reason the tour exists at all — an empty app has
   * nothing to demonstrate the loop *with* — and the reason every step has to
   * be skippable: being asked to invent a task before you have decided to use
   * the thing is a fine reason to press past it. See
   * {@link OnboardingStep.title}'s neighbours in `OnboardingDialog` for how
   * the primary button reads when a doing step has not been done.
   */
  isDoingStep: boolean;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "welcome",
    title: "Welcome to Routine Launcher",
    summary: "A desktop hub that connects what you need to do with everything you need to start.",
    isDoingStep: false,
  },
  {
    id: "task",
    title: "Start with a task",
    summary: "The loop begins with something you actually have to get done.",
    isDoingStep: true,
  },
  {
    id: "routine",
    title: "Give it a routine",
    summary: "One press opens the apps, files and sites that task needs.",
    isDoingStep: true,
  },
  {
    id: "focus",
    title: "Then focus",
    summary: "The workspace opens and the clock starts, in the same press.",
    isDoingStep: false,
  },
  {
    id: "progress",
    title: "And it all adds up",
    summary: "Finished work becomes XP, levels, achievements and a streak.",
    isDoingStep: false,
  },
];

/** Total steps, for the "Step 2 of 5" counter and the store's clamping. */
export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

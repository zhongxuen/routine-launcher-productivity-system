import { Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { previewSound } from "@/lib/sounds";
import { useMotionStore, type MotionPreference } from "@/stores/motionStore";
import { useSoundStore } from "@/stores/soundStore";

/**
 * The two feedback settings from development-plan.md section 84 — how much
 * the app moves, and whether it makes any noise.
 *
 * They share a card because they are the same question asked twice: how much
 * does the app want to be noticed while you are working. Someone who turns
 * one down usually wants the other down too, and putting them a click apart
 * in separate cards would hide that.
 *
 * Neither writes to the database. Both are properties of *this machine* —
 * animations are a rendering cost that depends on the hardware, and sound
 * depends on whether the user is somewhere they can be heard — so they live
 * in localStorage next to the theme, and travel with the install rather than
 * the profile. The same TODO on `themeStore` applies if section 52's settings
 * table ever takes them over.
 *
 * Unlike the tray and command-action switches next to it, neither direction
 * asks for confirmation or shows a toast. Both are immediately, visibly and
 * audibly self-evident: the switch is the feedback.
 */
function MotionSoundCard() {
  const motion = useMotionStore((state) => state.preference);
  const setMotion = useMotionStore((state) => state.setPreference);
  const isSoundEnabled = useSoundStore((state) => state.isEnabled);
  const setSoundEnabled = useSoundStore((state) => state.setEnabled);

  function handleSoundChange(next: boolean) {
    setSoundEnabled(next);
    // Only on the way on. Playing a cue to confirm that sound has been turned
    // off would be a small joke at the user's expense.
    if (next) previewSound("task-complete");
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Motion &amp; sound</CardTitle>
        <CardDescription>
          How much the app animates as things happen, and whether it plays a short tone when a
          task, focus session or routine finishes.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="animations">Animations</Label>
            <Select
              value={motion}
              onValueChange={(value) => setMotion(value as MotionPreference)}
            >
              <SelectTrigger id="animations" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full</SelectItem>
                <SelectItem value="reduced">Reduced</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            &quot;System&quot; follows the Windows setting for animation effects, which is the
            default. &quot;Reduced&quot; keeps every transition but removes the movement.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="sound-effects">Sound effects</Label>
            <div className="flex items-center gap-2">
              {/* Only offered once there is something to hear. */}
              {isSoundEnabled && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => previewSound("focus-complete")}
                  aria-label="Play a sample sound"
                >
                  <Volume2 className="size-4" />
                </Button>
              )}
              <Switch
                id="sound-effects"
                checked={isSoundEnabled}
                onCheckedChange={handleSoundChange}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Off by default. The tones are short and quiet, and they follow your Windows volume.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default MotionSoundCard;

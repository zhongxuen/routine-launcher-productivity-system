import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface DayNavProps {
  /** Whether the day on screen is today, which disables the Today button. */
  isToday: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
}

/**
 * Section 53's `< Today >`: a day back, a day on, and a way home.
 *
 * Deliberately not a calendar. Section 53 says not to build one, and section
 * 54 says the question is "what do I need to do today". Yesterday and
 * tomorrow are a click away and anything further is a few, which is all a
 * daily list needs.
 */
function DayNav({ isToday, onPrevious, onNext, onToday }: DayNavProps) {
  return (
    <div role="group" aria-label="Choose a day" className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" onClick={onPrevious} aria-label="Previous day">
            <ChevronLeft className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Previous day</TooltipContent>
      </Tooltip>

      <Button size="sm" variant="outline" onClick={onToday} disabled={isToday}>
        Today
      </Button>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" onClick={onNext} aria-label="Next day">
            <ChevronRight className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Next day</TooltipContent>
      </Tooltip>
    </div>
  );
}

export default DayNav;

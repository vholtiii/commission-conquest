import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type TipProps = {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** When true, wrap children so disabled buttons still receive hover. */
  wrapDisabled?: boolean;
};

/**
 * Game-chrome tooltip. Pass wrapDisabled when the child may be a disabled Button
 * (native disabled elements do not fire pointer events).
 */
export default function Tip({
  content,
  children,
  side = "top",
  wrapDisabled = false,
}: TipProps) {
  if (content == null || content === false || content === "") {
    return <>{children}</>;
  }

  const trigger = wrapDisabled ? (
    <span className="inline-flex">{children}</span>
  ) : (
    children
  );

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        side={side}
        className="max-w-[220px] border-panel-border bg-panel-elevated px-2.5 py-1.5 text-xs leading-snug text-foreground shadow-lg"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

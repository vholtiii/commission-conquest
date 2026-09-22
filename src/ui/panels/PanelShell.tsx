import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { cn } from "@/lib/utils";

interface PanelShellProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  onClose?: () => void;
  width?: string;
}

/** Shared floating panel frame used by all side panels for a consistent City of Gangsters-style look. */
export default function PanelShell({ title, subtitle, children, className, onClose, width = "w-[380px]" }: PanelShellProps) {
  const setPanel = useGameStore((s) => s.setPanel);

  return (
    <div className={cn("panel-surface-elevated pointer-events-auto relative z-40 flex max-h-[calc(100%-2rem)] flex-col rounded-lg border shadow-card-elevated", width, className)}>
      <div className="flex items-center justify-between border-b border-panel-border px-4 py-2.5">
        <div>
          <h2 className="font-display text-sm text-steel-light">{title}</h2>
          {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={() => (onClose ? onClose() : setPanel("none"))}
          className="rounded p-1 text-muted-foreground hover:bg-panel-border hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
}

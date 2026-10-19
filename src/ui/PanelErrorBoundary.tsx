import { Component, type ReactNode } from "react";
import { useGameStore } from "@/engine/store";

function PanelFallback() {
  const setPanel = useGameStore((s) => s.setPanel);
  return (
    <div className="panel-surface-elevated pointer-events-auto w-[380px] rounded-lg border p-4 shadow-card-elevated">
      <h2 className="font-display text-sm text-steel-light">This panel hit a snag</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        The rest of the city is fine. Close this and keep playing.
      </p>
      <button
        type="button"
        className="mt-3 rounded bg-steel px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white"
        onClick={() => setPanel("none")}
      >
        Close
      </button>
    </div>
  );
}

interface Props {
  children: ReactNode;
  resetKey?: string;
}

interface State {
  failed: boolean;
  resetKey?: string;
}

/** A panel crash stays in the panel. The map and the rest of the shell keep running. */
export default class PanelErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { failed: false, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (this.state.failed) return <PanelFallback />;
    return this.props.children;
  }
}

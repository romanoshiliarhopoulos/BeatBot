import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional label shown in the fallback UI */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches rendering errors in any child subtree and shows a compact inline
 * fallback instead of crashing the whole tab.
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", this.props.label ?? "", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center py-4 px-3 text-[11px] text-gray-600 border border-white/5 rounded-lg bg-[#0a0a16]">
          <span>
            {this.props.label ? `${this.props.label}: ` : ""}
            Rendering error — reload the page to retry.
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}

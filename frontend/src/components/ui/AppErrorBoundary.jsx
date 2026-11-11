'use client';

import { Component } from 'react';

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : (typeof error === 'string' ? error : '')
    };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Mirabilis UI render failure:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full items-center justify-center p-6">
          <div className="au-material-thick max-w-md rounded-3xl border border-amber-300/60 p-6 text-center shadow-[var(--shadow-3)] dark:border-amber-500/30">
            <h2 className="text-lg font-semibold tracking-tight text-[color:var(--text-main)]">
              This view failed to load
            </h2>
            {/* Error text can be long; the full message stays in the tooltip. */}
            {this.state.message ? (
              <p
                className="mt-2 line-clamp-4 break-words text-sm leading-relaxed text-[color:var(--text-muted)]"
                title={this.state.message}
              >
                {this.state.message}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:brightness-95"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

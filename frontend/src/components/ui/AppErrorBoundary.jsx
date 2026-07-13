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
      message: error instanceof Error ? error.message : 'Unexpected client-side rendering error.'
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
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">
              View Failed To Load
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-tight text-[color:var(--text-main)]">
              This panel hit a client-side error.
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[color:var(--text-muted)]">
              {this.state.message || 'Refresh the page or switch tabs. The rest of the app shell is still available.'}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:brightness-95"
            >
              Reload UI
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

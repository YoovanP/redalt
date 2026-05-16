import { Component, type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="state-view" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
            <h2 style={{ margin: '0 0 0.5rem' }}>Something went wrong</h2>
            <p style={{ opacity: 0.75, fontSize: '0.9rem' }}>{this.state.error?.message ?? 'An unexpected error occurred.'}</p>
            <button
              type="button"
              className="post-action-button"
              style={{ marginTop: '1rem' }}
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try again
            </button>
          </div>
        )
      );
    }

    return this.props.children;
  }
}

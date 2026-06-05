import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <div className="brand-lockup">
            <span className="brand-mark">!</span>
            <div>
              <h1>mudslingers</h1>
              <p>Something interrupted the app.</p>
            </div>
          </div>
          <p className="notice">{this.state.error.message}</p>
          <button
            className="primary-action"
            type="button"
            onClick={() => {
              try {
                localStorage.removeItem("coffee-pin-demo-state-v1");
              } catch {
                // Reloading is still useful if storage is unavailable.
              }
              window.location.reload();
            }}
          >
            Reset Demo
          </button>
        </section>
      </main>
    );
  }
}

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  Component,
  createElement,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { ReactPlugin } from "./ReactPlugin.js";

function normalizeError(error: unknown): Error {
  try {
    // Snapshot even Error instances: proxies can expose safe descriptors but throw on reads.
    if (error !== null && typeof error === "object") {
      const source = error as { message?: unknown; name?: unknown; stack?: unknown };
      const message = source.message;
      if (typeof message === "string") {
        const normalized = new Error(message);
        for (const key of ["name", "stack"] as const) {
          try {
            const value = source[key];
            if (typeof value === "string") normalized[key] = value;
          } catch {
            // Optional metadata must not replace a safe recovery message.
          }
        }
        return normalized;
      }
    }
    return new Error(String(error));
  } catch {
    return new Error("Unknown error");
  }
}

/**
 * Props passed to an error boundary's fallback component. React supplies component information
 * after the first recovery render, so `errorInfo` can initially be null.
 * @public
 */
export interface IAppInsightsErrorBoundaryFallbackProps {
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/** Error boundary configuration and descendants. @public */
export interface IAppInsightsErrorBoundaryProps {
  appInsights: ReactPlugin;
  onError: ComponentType<IAppInsightsErrorBoundaryFallbackProps>;
  children: ReactNode;
}

/** Current error boundary recovery state. @public */
export interface IAppInsightsErrorBoundaryState extends IAppInsightsErrorBoundaryFallbackProps {
  hasError: boolean;
}

/**
 * Reports errors caught from descendant components and renders the supplied fallback.
 *
 * @remarks
 * Exceptions are reported at severity 3 with the React component stack. Like React error
 * boundaries, this does not catch event-handler errors, asynchronous errors or server-render errors.
 * Rendering itself does not emit telemetry.
 * @public
 */
export class AppInsightsErrorBoundary extends Component<
  IAppInsightsErrorBoundaryProps,
  IAppInsightsErrorBoundaryState
> {
  public state: IAppInsightsErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: unknown): IAppInsightsErrorBoundaryState {
    return { hasError: true, error: normalizeError(error), errorInfo: null };
  }

  public componentDidCatch(thrown: unknown, errorInfo: ErrorInfo): void {
    const error = this.state.error ?? normalizeError(thrown);
    this.setState({ hasError: true, error, errorInfo });
    this.props.appInsights.trackException({
      error,
      exception: error,
      severityLevel: 3,
      properties: { componentStack: errorInfo.componentStack ?? "" },
    });
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return createElement(this.props.onError, {
        error: this.state.error,
        errorInfo: this.state.errorInfo,
      });
    }
    return this.props.children;
  }
}

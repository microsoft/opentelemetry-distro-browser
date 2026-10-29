// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  Component,
  createElement,
  useCallback,
  useEffect,
  useRef,
  type ComponentClass,
  type ComponentType,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import type { CustomProperties } from "../telemetry.js";
import type { ReactPlugin } from "./ReactPlugin.js";

// Quiet gaps reaching this threshold are wholly idle, including the detection window.
const idleTimeoutMs = 5000;

class EngagementTracker {
  #active = false;
  #generation = 0;
  #lastActivity: number | undefined;
  #engagedMs = 0;
  #configuration:
    { plugin: ReactPlugin; componentName: string; customProperties?: CustomProperties } | undefined;

  public configure(
    plugin: ReactPlugin,
    componentName: string,
    customProperties?: CustomProperties,
  ): void {
    this.#configuration = { plugin, componentName, customProperties };
  }

  public mount(): void {
    this.#active = true;
    this.#generation++;
  }

  public trackActivity(): void {
    if (!this.#active) return;
    const now = this.now();
    this.#engagedMs += this.activeGap(now);
    this.#lastActivity = now;
  }

  public unmount(): void {
    if (!this.#active) return;
    this.#active = false;
    if (this.#lastActivity === undefined) return;
    const average = Math.max(0, this.#engagedMs + this.activeGap(this.now())) / 1000;
    const configuration = this.#configuration;
    const generation = ++this.#generation;

    // StrictMode immediately mounts again after its simulated cleanup. Cancel that cleanup,
    // preserving interaction state, without a timer or telemetry from a synthetic mount.
    queueMicrotask(() => {
      if (generation !== this.#generation) return;
      this.#lastActivity = undefined;
      this.#engagedMs = 0;
      configuration?.plugin.trackMetric(
        { name: "React Component Engaged Time (seconds)", average, sampleCount: 1 },
        { "Component Name": configuration.componentName, ...configuration.customProperties },
      );
    });
  }

  private now(): number {
    return typeof performance === "undefined" ? Date.now() : performance.now();
  }

  private activeGap(now: number): number {
    if (this.#lastActivity === undefined) return 0;
    const gap = Math.max(0, now - this.#lastActivity);
    return gap < idleTimeoutMs ? gap : 0;
  }
}

/**
 * Tracks component engagement after the first call to the returned activity callback.
 *
 * @remarks
 * On unmount, emits `React Component Engaged Time (seconds)` with sample count 1 and a
 * `Component Name` property. Gaps of at least five seconds without activity are excluded in
 * their entirety, including the final idle gap. No interaction means no metric. No interval
 * runs, and durations are never negative. Emission is deferred by one microtask to suppress
 * StrictMode cleanup replay. The most recently committed plugin, name and custom properties
 * are used on unmount; changing them does not itself emit a metric.
 * @public
 */
export function useTrackMetric(
  reactPlugin: ReactPlugin,
  componentName: string,
  customProperties?: CustomProperties,
): () => void {
  const tracker = useRef<EngagementTracker | null>(null);
  if (tracker.current === null) tracker.current = new EngagementTracker();
  const tracking = tracker.current;

  useEffect(() => {
    tracking.configure(reactPlugin, componentName, customProperties);
  }, [tracking, reactPlugin, componentName, customProperties]);

  useEffect(() => {
    tracking.mount();
    return () => tracking.unmount();
  }, [tracking]);

  return useCallback(() => tracking.trackActivity(), [tracking]);
}

/**
 * Base class for class components that wire their own activity handlers.
 *
 * @remarks
 * Calls to `trackActivity` use the same engagement calculation and StrictMode cleanup handling
 * as `useTrackMetric`. Subclasses overriding lifecycle methods must call the base methods.
 * This class does not implement the upstream extension's private timer fields.
 * @public
 */
export abstract class AITrackedComponentBase<P> extends Component<P> {
  protected _reactPlugin: ReactPlugin;
  protected _componentName: string;
  readonly #tracker = new EngagementTracker();

  public constructor(props: P, reactPlugin: ReactPlugin, componentName: string) {
    super(props);
    this._reactPlugin = reactPlugin;
    this._componentName = componentName;
  }

  public componentDidMount(): void {
    this.#tracker.configure(this._reactPlugin, this._componentName);
    this.#tracker.mount();
  }

  public componentDidUpdate(): void {
    this.#tracker.configure(this._reactPlugin, this._componentName);
  }

  public componentWillUnmount(): void {
    this.#tracker.unmount();
  }

  /** Records interaction only while the component is mounted. */
  protected trackActivity = (_event?: SyntheticEvent): void => {
    this.#tracker.trackActivity();
  };
}

/**
 * Wraps a component in an activity-observing div, forwarding its original props unchanged.
 *
 * @remarks
 * The wrapper observes key down, mouse move, scroll, mouse down, touch start and touch move.
 * `className` applies to the wrapper. Engagement follows `useTrackMetric`; use that hook instead
 * when an additional div would be inappropriate for the application's markup.
 * @public
 */
export function withAITracking<P extends object>(
  reactPlugin: ReactPlugin,
  component: ComponentType<P>,
  componentName?: string,
  className = "",
): ComponentClass<P> {
  const name = componentName ?? component.displayName ?? (component.name || "Unknown");

  return class AITrackedComponent extends AITrackedComponentBase<P> {
    public static displayName = `withAITracking(${name})`;

    public constructor(props: P) {
      super(props, reactPlugin, name);
    }

    public render(): ReactNode {
      return createElement(
        "div",
        {
          className,
          onKeyDown: this.trackActivity,
          onMouseMove: this.trackActivity,
          onScroll: this.trackActivity,
          onMouseDown: this.trackActivity,
          onTouchStart: this.trackActivity,
          onTouchMove: this.trackActivity,
        },
        createElement(component, this.props),
      );
    }
  };
}

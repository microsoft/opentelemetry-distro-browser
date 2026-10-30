// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  InternalPageViewInstrumentationConfig,
  PageViewInstrumentationConfig,
} from "../../instrumentation/pageView/types.js";
import { ROUTE_SOURCE_ACTIVE } from "../../shared/constants.js";
import { FrameworkPlugin } from "../telemetry.js";

/**
 * Optional routing configuration for the React integration.
 * @public
 */
export interface IReactExtensionConfig {
  /**
   * A structural history v4 or v5 instance. Observes committed pathname, query and hash changes
   * without requiring a React Router or history runtime dependency.
   */
  history?: {
    readonly location: {
      readonly pathname: string;
      readonly search?: string;
      readonly hash?: string;
    };
    listen(
      listener: (
        location:
          | { readonly pathname: string; readonly search?: string; readonly hash?: string }
          | {
              readonly location: {
                readonly pathname: string;
                readonly search?: string;
                readonly hash?: string;
              };
              readonly action: string;
            },
        action?: string,
      ) => void,
    ): () => void;
  };

  /** Supplies a route pattern for aggregation; undefined falls back to the document title. */
  routeResolver?: () => string | undefined;
}

/**
 * Instance-bound React telemetry helpers with an optional history navigation source.
 *
 * @remarks
 * Pass this instance in `instrumentations` and its `pageView` configuration in `pageView` when
 * calling `useMicrosoftOpenTelemetry`. Supply the same plugin as the `AppInsightsContext`
 * provider value. Construction does not subscribe to history or initialize telemetry.
 *
 * This adapter exposes familiar React helpers, not the Application Insights plugin protocol.
 * The distribution owns initial page views, correlation, navigation settling and subscriptions.
 * @public
 */
export class ReactPlugin extends FrameworkPlugin {
  /** Familiar framework identifier; no plugin-chain registration is performed. */
  public readonly identifier = "ReactPlugin";

  /**
   * Configuration to pass to the distribution's page-view instrumentation. A route source is
   * included only when history is supplied, replacing automatic History API observation.
   */
  public readonly pageView: PageViewInstrumentationConfig;
  #routesEnabled = true;
  readonly #routes = new Set<{ start(): void; stop(): void }>();

  public constructor(config: IReactExtensionConfig = {}) {
    super("@microsoft/opentelemetry-browser/react");
    const history = config.history;
    const urlOf = (location: { pathname: string; search?: string; hash?: string }): string =>
      location.pathname + (location.search ?? "") + (location.hash ?? "");
    let url = history ? urlOf(history.location) : "";
    let ignoredLocation = history?.location;
    let awaitingRoute = false;
    const pageView: InternalPageViewInstrumentationConfig = {
      ...(config.routeResolver ? { routeResolver: config.routeResolver } : {}),
      ...(history
        ? {
            routeSource: {
              // A resumed adapter cannot lead from a location reached while it was paused.
              [ROUTE_SOURCE_ACTIVE]: () =>
                this.#routesEnabled && (!awaitingRoute || history.location !== ignoredLocation),
              getCurrentUrl: () => {
                // History commits before invoking listeners. Read it even from earlier listeners,
                // but do not replay the location reached while observation was paused.
                if (this.#routesEnabled && history.location !== ignoredLocation) {
                  url = urlOf(history.location);
                }
                return url;
              },
              subscribe: (listener) => {
                let active = true;
                let unlisten: (() => void) | undefined;
                const registration = {
                  start: () => {
                    if (!active || unlisten || !this.#routesEnabled) return;
                    ignoredLocation = history.location;
                    unlisten = history.listen((update, action) => {
                      if (!active || !this.#routesEnabled) return;
                      const location = "location" in update ? update.location : update;
                      if (location === ignoredLocation) return;
                      ignoredLocation = undefined;
                      awaitingRoute = false;
                      url = urlOf(location);
                      const navigationAction = "location" in update ? update.action : action;
                      const type =
                        navigationAction === "PUSH"
                          ? "push"
                          : navigationAction === "REPLACE"
                            ? "replace"
                            : navigationAction === "POP"
                              ? "traverse"
                              : undefined;
                      listener({ url, ...(type ? { type } : {}) });
                    });
                  },
                  stop: () => {
                    const stop = unlisten;
                    unlisten = undefined;
                    if (stop) awaitingRoute = true;
                    stop?.();
                  },
                };
                this.#routes.add(registration);
                try {
                  registration.start();
                } catch (error) {
                  this.#routes.delete(registration);
                  throw error;
                }
                return () => {
                  if (!active) return;
                  active = false;
                  this.#routes.delete(registration);
                  registration.stop();
                };
              },
            },
          }
        : {}),
    };
    this.pageView = pageView;
  }

  /** Resumes route observation and helper telemetry. Navigations while paused are not replayed. */
  public override enable(): void {
    super.enable();
    this.#routesEnabled = true;
    for (const route of this.#routes) route.start();
  }

  /** Pauses router subscriptions and helper telemetry without shutting down the SDK. */
  public override disable(): void {
    super.disable();
    this.#routesEnabled = false;
    for (const route of this.#routes) {
      try {
        route.stop();
      } catch {
        /* Continue releasing sibling subscriptions. */
      }
    }
  }
}

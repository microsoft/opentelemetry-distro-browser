// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type LogRecord } from "@opentelemetry/api-logs";

/**
 * Which resolution step produced the page name.
 *
 * @remarks
 * Resolution order is explicit name, then framework route pattern, then `document.title`, then
 * `location.pathname`. Aggregate on the page name only where the source is `explicit` or `route`;
 * treat `document_title` and `url_path` as high-cardinality diagnostic values.
 *
 * @public
 */
export type PageViewNameSource = "explicit" | "route" | "document_title" | "url_path";

/**
 * How the emitted page-view duration was obtained.
 *
 * @remarks
 * Only `navigation_timing` is browser-reported. Every `soft_navigation_*` value is a heuristic
 * owned by this distribution and is not comparable with a document-load duration. The
 * `soft_navigation_capped`, `soft_navigation_interrupted` and `page_hide` values are lower bounds
 * rather than measurements, and should be excluded from duration percentiles.
 *
 * @public
 */
export type PageViewDurationSource =
  | "navigation_timing"
  | "document_load"
  | "soft_navigation_settled"
  | "soft_navigation_capped"
  | "soft_navigation_interrupted"
  | "page_hide";

/**
 * Normalized navigation type.
 *
 * @remarks
 * The first four values describe a document load and mirror `PerformanceNavigationTiming.type`.
 * The last three describe an in-document route change and mirror the upstream
 * `browser.navigation.type` vocabulary. Unlike upstream `browser.navigation`, this is always
 * populated, so a missing value never has to be guessed at query time.
 *
 * @public
 */
export type PageViewNavigationType =
  "navigate" | "reload" | "back_forward" | "prerender" | "push" | "replace" | "traverse";

/**
 * An in-flight or completed page view.
 *
 * @remarks
 * Published as soon as the navigation is observed, which is well before the log record is emitted.
 * That ordering is deliberate: a processor stamping {@link PageView.id} onto other signals must see
 * the id while the page is still loading, not after it has settled.
 *
 * @public
 */
export interface PageView {
  /**
   * Correlation id minted for this navigation. Opaque, currently 32 lowercase hexadecimal
   * characters. It is not a trace id and must not be parsed or used as one.
   */
  readonly id: string;
  /** Zero-based ordinal of this page view within the document's lifetime. */
  readonly index: number;
  /** Resolved page name. */
  readonly name: string;
  /** Which resolution step produced {@link PageView.name}. */
  readonly nameSource: PageViewNameSource;
  /** Full URL, after `sanitizeUrl` when one is configured. */
  readonly url: string;
  /** Referring URL, after `sanitizeUrl`. Empty when unknown. */
  readonly referrer: string;
  /** Normalized navigation type. */
  readonly navigationType: PageViewNavigationType;
  /** False for a document load, true for an in-document route change. */
  readonly sameDocument: boolean;
  /** Wall-clock start of the navigation, in epoch milliseconds. */
  readonly startTimeUnixMs: number;
}

/**
 * Notified whenever a new page view becomes current.
 * @public
 */
export type PageViewListener = (pageView: PageView) => void;

/**
 * Read-only view of the current page view.
 *
 * @remarks
 * This is the seam a correlation processor consumes. It exposes no way to mint or mutate a page
 * view, so a consumer cannot influence page-view lifetime, and it carries no dependency on the
 * instrumentation itself.
 *
 * @public
 */
export interface PageViewSource {
  /**
   * The page view that is current now, or undefined before the first navigation is observed.
   */
  getCurrentPageView(): PageView | undefined;
  /**
   * Subscribe to page-view changes.
   *
   * @returns A handle that removes the subscription. Release it during shutdown.
   */
  onPageViewChanged(listener: PageViewListener): () => void;
}

/**
 * Writable side of the page-view seam, owned by whatever mints page views.
 *
 * @remarks
 * Split from {@link PageViewSource} so that consumers can only read. Create one with
 * `createPageViewContext` and pass it to both the instrumentation and the component that needs to
 * read from it.
 *
 * @public
 */
export interface PageViewContext extends PageViewSource {
  /** Publishes a new current page view and notifies subscribers. */
  setCurrentPageView(pageView: PageView): void;
  /** Drops the current page view and every subscription. */
  clear(): void;
}

/**
 * Modifies the log record immediately before it is emitted.
 * @public
 */
export type ApplyCustomLogRecordDataFunction = (logRecord: LogRecord) => void;

/**
 * Removes sensitive segments from a URL before it is recorded.
 * @public
 */
export type SanitizeUrlFunction = (url: string) => string;

/**
 * Supplies the current framework route pattern, such as `/orders/:id`.
 *
 * @remarks
 * Prefer a route pattern over a resolved path: patterns aggregate, concrete paths do not. Return
 * undefined when no route is known, so resolution falls through to `document.title`.
 *
 * @public
 */
export type RouteResolverFunction = () => string | undefined;

/**
 * Configuration for `PageViewInstrumentation`.
 *
 * @remarks
 * Structurally compatible with `InstrumentationConfig` from `@opentelemetry/instrumentation`, but
 * declared standalone rather than extending it. That package's type entry point resolves to its
 * Node platform build, which references Node built-ins, so inheriting from it would force every
 * browser consumer of this package's declarations to install Node typings.
 *
 * @public
 */
export interface PageViewInstrumentationConfig {
  /**
   * Whether the instrumentation starts observing as soon as it is constructed.
   *
   * @defaultValue true
   */
  readonly enabled?: boolean;

  /**
   * Supplies the framework route pattern. Called once per navigation, when the navigation is
   * observed.
   */
  readonly routeResolver?: RouteResolverFunction;

  /** Sanitizes the page URL and the referrer before they are recorded. */
  readonly sanitizeUrl?: SanitizeUrlFunction;

  /** Modifies the log record immediately before it is emitted. */
  readonly applyCustomLogRecordData?: ApplyCustomLogRecordDataFunction;

  /**
   * Upper bound, in milliseconds, on how long a soft navigation may wait to settle before its page
   * view is emitted anyway with a `soft_navigation_capped` duration source.
   *
   * @defaultValue 10000
   */
  readonly softNavigationSettleTimeoutMs?: number;

  /**
   * Use the experimental Navigation API when the browser exposes it, instead of patching `history`.
   *
   * @defaultValue false
   */
  readonly useNavigationApiIfAvailable?: boolean;

  /**
   * Page-view context to publish into.
   *
   * @remarks
   * Supply one when another component, typically a correlation processor, must share a single
   * page-view identity. When omitted the instrumentation creates its own and exposes it through
   * `pageViews`. It is never a module-level global, so independent instances stay independent.
   */
  readonly pageViewContext?: PageViewContext;

  /**
   * Overrides page-view id generation, for tests and for consumers that must align ids with an
   * existing correlation scheme.
   */
  readonly generatePageViewId?: () => string;
}

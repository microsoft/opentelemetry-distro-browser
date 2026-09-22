// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type LogRecord } from "@opentelemetry/api-logs";
import { InstrumentationBase, safeExecuteInTheMiddle } from "@opentelemetry/instrumentation";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../shared/constants.js";
import { createPageViewContext, generatePageViewId } from "./pageViewContext.js";
import {
  ATTR_PAGE_VIEW_DURATION,
  ATTR_PAGE_VIEW_DURATION_SOURCE,
  ATTR_PAGE_VIEW_ID,
  ATTR_PAGE_VIEW_INDEX,
  ATTR_PAGE_VIEW_NAME,
  ATTR_PAGE_VIEW_NAME_SOURCE,
  ATTR_PAGE_VIEW_REFERRER,
  ATTR_PAGE_VIEW_SAME_DOCUMENT,
  ATTR_PAGE_VIEW_TYPE,
  ATTR_URL_FULL,
  DURATION_SOURCE_DOCUMENT_LOAD,
  DURATION_SOURCE_NAVIGATION_TIMING,
  DURATION_SOURCE_PAGE_HIDE,
  DURATION_SOURCE_SOFT_CAPPED,
  DURATION_SOURCE_SOFT_INTERRUPTED,
  DURATION_SOURCE_SOFT_SETTLED,
  EVENT_BROWSER_PAGE_VIEW,
  NAME_SOURCE_DOCUMENT_TITLE,
  NAME_SOURCE_EXPLICIT,
  NAME_SOURCE_ROUTE,
  NAME_SOURCE_URL_PATH,
  PAGE_VIEW_TYPE_BACK_FORWARD,
  PAGE_VIEW_TYPE_NAVIGATE,
  PAGE_VIEW_TYPE_PRERENDER,
  PAGE_VIEW_TYPE_PUSH,
  PAGE_VIEW_TYPE_RELOAD,
  PAGE_VIEW_TYPE_REPLACE,
  PAGE_VIEW_TYPE_TRAVERSE,
  SEVERITY_NUMBER_INFO,
} from "./semconv.js";
import {
  type InternalPageViewInstrumentationConfig,
  type PageView,
  type PageViewContext,
  type PageViewDurationSource,
  type PageViewNameSource,
  type PageViewNavigationType,
  type PageViewSource,
} from "./types.js";

/**
 * Instrumentation scope name for the page-view event.
 * @public
 */
export const PAGE_VIEW_INSTRUMENTATION_NAME = "@microsoft/opentelemetry-distro-browser/page-view";

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 1_000;

type SoftNavigationTrigger =
  "pushState" | "replaceState" | "popstate" | "hashchange" | "currententrychange";

interface PendingPageView {
  /**
   * Mutable so a late {@link PageViewInstrumentation.setPageName} can correct the name in place.
   * Callbacks scheduled for this navigation hold the pending object by identity, so replacing it
   * would orphan them and the record would never be emitted.
   */
  pageView: PageView;
  /** Monotonic start, from `performance.now()`. */
  readonly startedAt: number;
  capTimerId?: number;
}

/**
 * Minimal structural view of the experimental Navigation API, typed locally because it is absent
 * from the DOM library and must not be reached through an upstream internal path.
 */
interface NavigationApiLike extends EventTarget {
  readonly currentEntry?: { readonly url?: string | null } | null;
}

interface NavigationCurrentEntryChangeEventLike extends Event {
  readonly navigationType?: string | null;
}

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
}

type RequestIdleCallbackLike = (
  callback: (deadline: IdleDeadlineLike) => void,
  options?: { timeout: number },
) => number;

/**
 * Emits one `browser.page_view` log record per navigation: the initial document load, plus every
 * in-document route change in a single-page application.
 *
 * @remarks
 * Upstream `@opentelemetry/browser-instrumentation` has no page-view concept, and its
 * `browser.navigation` event carries no page name, no duration, no referrer and no correlation id.
 * This instrumentation is additive and distribution-owned: it extends the same upstream
 * `InstrumentationBase`, so it composes with the upstream modules instead of replacing them, and
 * it emits portable OpenTelemetry with no backend schema or vendor field names.
 *
 * Running this alongside upstream `NavigationInstrumentation` produces two records per navigation.
 * `browser.page_view` is a superset of the useful content, so prefer enabling one of the two.
 *
 * @example
 * ```ts
 * const pageView = new PageViewInstrumentation({
 *   routeResolver: () => router.currentRoute.value.matched[0]?.path,
 * });
 * const pageViewId = pageView.pageViews.getCurrentPageView()?.id;
 * ```
 *
 * @public
 */
export class PageViewInstrumentation extends InstrumentationBase<InternalPageViewInstrumentationConfig> {
  private enabledState = false;
  private historyPatched = false;
  private readonly context: PageViewContext;
  private readonly ownsContext: boolean;

  private pending: PendingPageView | undefined;
  private pageViewIndex = 0;
  private lastUrl = "";
  private explicitName: string | undefined;

  private onLoad: (() => void) | undefined;
  private onPopState: (() => void) | undefined;
  private onHashChange: (() => void) | undefined;
  private onPageHide: (() => void) | undefined;
  private onCurrentEntryChange: ((event: Event) => void) | undefined;

  public constructor(config: InternalPageViewInstrumentationConfig = {}) {
    // `InstrumentationBase` calls `enable()` from its own constructor, which runs before this
    // subclass's field initializers. That would observe an undefined page-view context, and the
    // initializers would then overwrite the state `enable()` had just set. Start disabled, finish
    // construction, then honor the caller's setting.
    super(PAGE_VIEW_INSTRUMENTATION_NAME, OPENTELEMETRY_BROWSER_VERSION, {
      ...config,
      enabled: false,
    });
    this.ownsContext = config.pageViewContext === undefined;
    this.context = config.pageViewContext ?? createPageViewContext();
    this.setConfig(config);
    if (this.getConfig().enabled) {
      this.enable();
    }
  }

  /**
   * Read-only page-view seam.
   *
   * @remarks
   * A correlation processor reads the current page-view id from here and stamps it onto the
   * signals it sees. Exposed as {@link PageViewSource} rather than the writable context, so a
   * consumer cannot mint or mutate page views.
   */
  public get pageViews(): PageViewSource {
    return this.context;
  }

  /**
   * Supplies an application-controlled page name, which outranks every other name source.
   *
   * @remarks
   * Applies to the page view currently in flight when it has not been emitted yet, and to every
   * later navigation until changed. For a soft navigation the in-flight window is the settle
   * window, so a router should call this synchronously from its route-change handler. Pass
   * undefined to fall back to route, then title, then path.
   *
   * @param name - The page name, or undefined to clear it.
   */
  public setPageName(name: string | undefined): void {
    this.explicitName = name;
    const pending = this.pending;
    if (pending && name !== undefined && pending.pageView.name !== name) {
      // Mutated in place: callbacks already scheduled for this navigation hold `pending` by
      // identity, so replacing it would strand both the settle path and the cap timer.
      const updated: PageView = { ...pending.pageView, name, nameSource: NAME_SOURCE_EXPLICIT };
      pending.pageView = updated;
      // Republish so a correlation consumer sees the corrected name before the record is emitted.
      this.context.setCurrentPageView(updated);
    }
  }

  protected init(): void {
    // Nothing is patched at module load. This instrumentation observes browser APIs only while it
    // is enabled, so importing it has no side effects.
  }

  public override enable(): void {
    if (this.enabledState) {
      return;
    }
    this.enabledState = true;
    this.lastUrl = location.href;

    const navigationApi = this.getNavigationApi();
    if (navigationApi) {
      this.onCurrentEntryChange = (event: Event): void => {
        this.handleSoftNavigation("currententrychange", event);
      };
      navigationApi.addEventListener("currententrychange", this.onCurrentEntryChange);
    } else {
      if (!this.historyPatched) {
        this._wrap(history, "pushState", this.patchHistoryMethod("pushState"));
        this._wrap(history, "replaceState", this.patchHistoryMethod("replaceState"));
        this.historyPatched = true;
      }
      this.onPopState = (): void => {
        this.handleSoftNavigation("popstate");
      };
      window.addEventListener("popstate", this.onPopState);
      this.onHashChange = (): void => {
        this.handleSoftNavigation("hashchange");
      };
      window.addEventListener("hashchange", this.onHashChange);
    }

    // A soft navigation that never settles would otherwise be lost when the user leaves.
    this.onPageHide = (): void => {
      this.settle(DURATION_SOURCE_PAGE_HIDE);
    };
    window.addEventListener("pagehide", this.onPageHide);

    this.startHardNavigation();
  }

  public override disable(): void {
    if (!this.enabledState) {
      return;
    }
    this.enabledState = false;

    if (this.onLoad) {
      window.removeEventListener("load", this.onLoad);
      this.onLoad = undefined;
    }
    if (this.onPopState) {
      window.removeEventListener("popstate", this.onPopState);
      this.onPopState = undefined;
    }
    if (this.onHashChange) {
      window.removeEventListener("hashchange", this.onHashChange);
      this.onHashChange = undefined;
    }
    if (this.onPageHide) {
      window.removeEventListener("pagehide", this.onPageHide);
      this.onPageHide = undefined;
    }
    if (this.onCurrentEntryChange) {
      this.getNavigationApi()?.removeEventListener("currententrychange", this.onCurrentEntryChange);
      this.onCurrentEntryChange = undefined;
    }
    if (this.historyPatched) {
      this._unwrap(history, "pushState");
      this._unwrap(history, "replaceState");
      this.historyPatched = false;
    }

    // Drop rather than emit. Distribution shutdown disables instrumentations before providers, and
    // a truncated record produced by shutdown is noise rather than signal.
    this.clearPending();
    if (this.ownsContext) {
      this.context.clear();
    }
    this.pageViewIndex = 0;
  }

  private startHardNavigation(): void {
    const timing = this.getNavigationTiming();
    const documentNavigation = this.begin({
      navigationType: this.mapHardNavigationType(timing?.type),
      sameDocument: false,
      referrer: document.referrer,
      // Anchor to the navigation start the browser reports, not to when the SDK initialized.
      startTimeUnixMs: performance.timeOrigin + (timing?.startTime ?? 0),
      startedAt: timing?.startTime ?? 0,
    });

    if (document.readyState === "complete") {
      this.scheduleMacrotask(() => {
        this.finalizeHardNavigation(documentNavigation);
      });
      return;
    }
    this.onLoad = (): void => {
      // `loadEventEnd` is populated only after the load event finishes dispatching.
      this.scheduleMacrotask(() => {
        this.finalizeHardNavigation(documentNavigation);
      });
    };
    window.addEventListener("load", this.onLoad, { once: true });
  }

  /**
   * Ends the document navigation with its browser-reported load duration.
   *
   * @param target - The navigation this callback was scheduled for. A soft navigation can start
   * before `load` fires, and that one has no document load duration, so anything but the original
   * navigation is left alone for its own settle path to finish.
   */
  private finalizeHardNavigation(target: PendingPageView): void {
    if (!this.enabledState || this.pending !== target) {
      return;
    }
    const timing = this.getNavigationTiming();
    if (timing && timing.loadEventEnd > 0) {
      this.emit(target, timing.loadEventEnd - timing.startTime, DURATION_SOURCE_NAVIGATION_TIMING);
      return;
    }
    this.emit(target, performance.now() - target.startedAt, DURATION_SOURCE_DOCUMENT_LOAD);
  }

  private getNavigationTiming(): PerformanceNavigationTiming | undefined {
    if (typeof performance?.getEntriesByType !== "function") {
      return undefined;
    }
    const [entry] = performance.getEntriesByType("navigation");
    return entry as PerformanceNavigationTiming | undefined;
  }

  private mapHardNavigationType(type: string | undefined): PageViewNavigationType {
    switch (type) {
      case "reload":
        return PAGE_VIEW_TYPE_RELOAD;
      case "back_forward":
        return PAGE_VIEW_TYPE_BACK_FORWARD;
      case "prerender":
        return PAGE_VIEW_TYPE_PRERENDER;
      default:
        // Also covers a missing navigation entry: a document exists, so it was navigated to.
        return PAGE_VIEW_TYPE_NAVIGATE;
    }
  }

  private getNavigationApi(): NavigationApiLike | undefined {
    if (!this.getConfig().useNavigationApiIfAvailable) {
      return undefined;
    }
    return (globalThis as { navigation?: NavigationApiLike }).navigation;
  }

  private patchHistoryMethod(
    trigger: "pushState" | "replaceState",
  ): (original: History["pushState"]) => History["pushState"] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentation = this;
    return (original: History["pushState"]): History["pushState"] => {
      return function patchedHistoryMethod(
        this: History,
        ...args: Parameters<History["pushState"]>
      ): void {
        if (!instrumentation.enabledState) {
          original.apply(this, args);
          return;
        }
        original.apply(this, args);
        if (location.href !== instrumentation.lastUrl) {
          instrumentation.handleSoftNavigation(trigger);
        }
      };
    };
  }

  private handleSoftNavigation(
    trigger: SoftNavigationTrigger,
    event?: NavigationCurrentEntryChangeEventLike,
  ): void {
    if (!this.enabledState) {
      return;
    }
    const previousUrl = this.lastUrl;
    const currentUrl =
      trigger === "currententrychange"
        ? (this.getNavigationApi()?.currentEntry?.url ?? location.href)
        : location.href;
    if (currentUrl === previousUrl) {
      return;
    }

    // Close out whatever was in flight first, so exactly one record is emitted per navigation.
    this.settle(DURATION_SOURCE_SOFT_INTERRUPTED);

    this.begin({
      navigationType: this.mapSoftNavigationType(trigger, event),
      sameDocument: true,
      referrer: previousUrl,
      url: currentUrl,
      startTimeUnixMs: Date.now(),
      startedAt: performance.now(),
    });
    this.scheduleSoftSettle();
  }

  private mapSoftNavigationType(
    trigger: SoftNavigationTrigger,
    event?: NavigationCurrentEntryChangeEventLike,
  ): PageViewNavigationType {
    if (trigger === "currententrychange") {
      switch (event?.navigationType) {
        case "traverse":
          return PAGE_VIEW_TYPE_TRAVERSE;
        case "replace":
          return PAGE_VIEW_TYPE_REPLACE;
        case "reload":
          return PAGE_VIEW_TYPE_RELOAD;
        default:
          return PAGE_VIEW_TYPE_PUSH;
      }
    }
    switch (trigger) {
      case "replaceState":
        return PAGE_VIEW_TYPE_REPLACE;
      case "popstate":
      case "hashchange":
        return PAGE_VIEW_TYPE_TRAVERSE;
      default:
        return PAGE_VIEW_TYPE_PUSH;
    }
  }

  /**
   * Schedules the end of a soft-navigation duration.
   *
   * @remarks
   * The browser reports no duration for an in-document route change, so this approximates one:
   * wait two animation frames, which lands after the first paint reflecting the new route, then
   * wait for the first idle callback, which lands after the synchronous work that paint triggered
   * has drained. A cap timer bounds the wait.
   */
  private scheduleSoftSettle(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }

    const timeout = this.getConfig().softNavigationSettleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    pending.capTimerId = window.setTimeout(() => {
      this.emit(pending, timeout, DURATION_SOURCE_SOFT_CAPPED);
    }, timeout);

    const afterPaint = (): void => {
      if (this.pending !== pending) {
        return;
      }
      this.whenIdle(() => {
        this.emit(pending, performance.now() - pending.startedAt, DURATION_SOURCE_SOFT_SETTLED);
      });
    };

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        requestAnimationFrame(afterPaint);
      });
    } else {
      this.scheduleMacrotask(afterPaint);
    }
  }

  private whenIdle(callback: () => void): void {
    const requestIdle = (globalThis as { requestIdleCallback?: RequestIdleCallbackLike })
      .requestIdleCallback;
    if (typeof requestIdle === "function") {
      requestIdle(
        () => {
          callback();
        },
        { timeout: IDLE_TIMEOUT_MS },
      );
      return;
    }
    this.scheduleMacrotask(callback);
  }

  private scheduleMacrotask(callback: () => void): void {
    window.setTimeout(callback, 0);
  }

  /** Starts a new page view and publishes it. Returns the pending record callbacks should target. */
  private begin(input: {
    navigationType: PageViewNavigationType;
    sameDocument: boolean;
    referrer: string;
    url?: string;
    startTimeUnixMs: number;
    startedAt: number;
  }): PendingPageView {
    const config = this.getConfig();
    const sanitize = config.sanitizeUrl;
    const rawUrl = input.url ?? location.href;
    const resolved = this.resolveName();

    const pageView: PageView = {
      id: (config.generatePageViewId ?? generatePageViewId)(),
      index: this.pageViewIndex++,
      name: resolved.name,
      nameSource: resolved.source,
      url: sanitize ? sanitize(rawUrl) : rawUrl,
      referrer: input.referrer ? (sanitize ? sanitize(input.referrer) : input.referrer) : "",
      navigationType: input.navigationType,
      sameDocument: input.sameDocument,
      startTimeUnixMs: input.startTimeUnixMs,
    };

    this.lastUrl = rawUrl;
    const pending: PendingPageView = { pageView, startedAt: input.startedAt };
    this.pending = pending;
    // Publish before the record is emitted, so signals produced during the navigation correlate.
    this.context.setCurrentPageView(pageView);
    return pending;
  }

  private resolveName(): { name: string; source: PageViewNameSource } {
    const explicit = this.explicitName;
    if (explicit) {
      return { name: explicit, source: NAME_SOURCE_EXPLICIT };
    }

    const routeResolver = this.getConfig().routeResolver;
    if (routeResolver) {
      const route = safeExecuteInTheMiddle(
        () => routeResolver(),
        (error) => {
          if (error) {
            this._diag.error("routeResolver hook failed", error);
          }
        },
        true,
      );
      if (route) {
        return { name: route, source: NAME_SOURCE_ROUTE };
      }
    }

    const title = document.title;
    if (title) {
      return { name: title, source: NAME_SOURCE_DOCUMENT_TITLE };
    }

    return { name: location.pathname, source: NAME_SOURCE_URL_PATH };
  }

  /** Ends whatever page view is in flight, if any, with the supplied reason. */
  private settle(source: PageViewDurationSource): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.emit(pending, performance.now() - pending.startedAt, source);
  }

  private emit(
    pending: PendingPageView,
    durationMs: number,
    durationSource: PageViewDurationSource,
  ): void {
    if (this.pending !== pending) {
      return;
    }
    this.clearPending();

    const pageView = pending.pageView;
    const logRecord: LogRecord = {
      eventName: EVENT_BROWSER_PAGE_VIEW,
      severityNumber: SEVERITY_NUMBER_INFO,
      timestamp: pageView.startTimeUnixMs,
      attributes: {
        [ATTR_URL_FULL]: pageView.url,
        [ATTR_PAGE_VIEW_ID]: pageView.id,
        [ATTR_PAGE_VIEW_INDEX]: pageView.index,
        [ATTR_PAGE_VIEW_NAME]: pageView.name,
        [ATTR_PAGE_VIEW_NAME_SOURCE]: pageView.nameSource,
        [ATTR_PAGE_VIEW_DURATION]: Math.max(0, durationMs),
        [ATTR_PAGE_VIEW_DURATION_SOURCE]: durationSource,
        [ATTR_PAGE_VIEW_TYPE]: pageView.navigationType,
        [ATTR_PAGE_VIEW_SAME_DOCUMENT]: pageView.sameDocument,
        ...(pageView.referrer ? { [ATTR_PAGE_VIEW_REFERRER]: pageView.referrer } : {}),
      },
    };

    const hook = this.getConfig().applyCustomLogRecordData;
    if (hook) {
      safeExecuteInTheMiddle(
        () => {
          hook(logRecord);
        },
        (error) => {
          if (error) {
            this._diag.error("applyCustomLogRecordData hook failed", error);
          }
        },
        true,
      );
    }

    this.logger.emit(logRecord);
  }

  private clearPending(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    if (pending.capTimerId !== undefined) {
      clearTimeout(pending.capTimerId);
    }
    this.pending = undefined;
  }
}

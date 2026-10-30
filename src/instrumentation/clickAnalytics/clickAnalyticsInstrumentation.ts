// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag } from "@opentelemetry/api";
import { SeverityNumber, type LogRecord } from "@opentelemetry/api-logs";
import { InstrumentationBase } from "@opentelemetry/instrumentation";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../shared/constants.js";
import { redactUrl } from "../../shared/urlRedaction.js";
import { getElementContent, getMetadata, isDoNotTrack } from "./content.js";
import type {
  ClickAnalyticsInstrumentationConfig,
  ClickAnalyticsPageAction,
  ClickAnalyticsPageActionOverrides,
  ClickAnalyticsProperties,
} from "./types.js";

const NOT_SPECIFIED = "not_specified";
const INPUT_TYPES = new Set(["button", "checkbox", "radio", "reset", "submit"]);
const DEFAULT_ELEMENTS = ["A", "BUTTON", "AREA", "INPUT"];

function assigned(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function contentName(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : NOT_SPECIFIED;
}

function targetUri(element: Element): string {
  if (element.tagName === "A" || element.tagName === "AREA") {
    return (element as HTMLAnchorElement).href;
  }
  if (element.tagName === "INPUT" && INPUT_TYPES.has((element as HTMLInputElement).type)) {
    return (element as HTMLInputElement).form?.action || location.pathname;
  }
  return "";
}

/**
 * Optional Application Insights-compatible click-content capture using OpenTelemetry logs.
 *
 * @remarks
 * Obtain a deferred instance from `createClickAnalyticsInstrumentation`, or select
 * `clickAnalytics: { enabled: true }` in `getInstrumentations`. Both factories are available from
 * the instrumentations entry point, not the SDK root. Do not also enable `userAction` unless duplicate action records
 * are intended. Each instance owns its listeners and emits through its bound logger provider.
 *
 * @internal
 */
export class ClickAnalyticsInstrumentation extends InstrumentationBase<ClickAnalyticsInstrumentationConfig> {
  // Read by the shared instrumentation ownership guard before providers are bound.
  private enabledState = false;
  #listening = false;
  #metadata: Record<string, string> = {};
  readonly #onAction = (event: Event): void => {
    this.#safely(() => this.#captureAutomatic(event));
  };

  public constructor(config: ClickAnalyticsInstrumentationConfig = {}) {
    // The base constructor otherwise enables before subclass fields have initialized.
    super("@microsoft/opentelemetry-browser/click-analytics", OPENTELEMETRY_BROWSER_VERSION, {
      ...config,
      enabled: false,
    });
    this.setConfig(config);
    if (this.getConfig().enabled) this.enable();
  }

  protected init(): void {}

  /** Applies a replacement configuration and updates automatic capture listeners. */
  public override setConfig(config: ClickAnalyticsInstrumentationConfig): void {
    super.setConfig(config);
    // The base constructor calls setConfig before private fields exist.
    if (this.enabledState) {
      this.disable();
      if (config.enabled !== false) this.enable();
    }
  }

  /** Starts capture; repeated calls do not add duplicate listeners. */
  public enable(): void {
    if (this.enabledState) return;
    this.enabledState = true;
    try {
      this.#metadata = getMetadata(this.getConfig());
      if (this.getConfig().autoCapture !== false && typeof window !== "undefined") {
        // A wrapper may register a listener and then throw, so arm cleanup before either call.
        this.#listening = true;
        window.addEventListener("mousedown", this.#onAction);
        window.addEventListener("keyup", this.#onAction);
      }
    } catch (error) {
      this.disable();
      throw error;
    }
  }

  /** Removes this instance's listeners and suppresses manual capture until re-enabled. */
  public disable(): void {
    this.enabledState = false;
    if (this.#listening) {
      window.removeEventListener("mousedown", this.#onAction);
      window.removeEventListener("keyup", this.#onAction);
      this.#listening = false;
    }
  }

  /** Captures element content and applies page-action overrides and custom properties. */
  public capturePageAction(
    element: Element,
    overrides: ClickAnalyticsPageActionOverrides = {},
    customProperties: ClickAnalyticsProperties = {},
    isRightClick = false,
  ): void {
    if (!this.enabledState) return;
    this.#safely(() => {
      const config = this.getConfig();
      const content = getElementContent(element, config);
      const validate = config.behaviorValidator ?? ((value: string | number) => value || "");
      let behavior = validate(
        assigned(overrides.behavior)
          ? (overrides.behavior as string | number)
          : (this.#metadata.behavior ?? ""),
      );
      if (isRightClick) behavior = config.defaultRightClickBhvr ?? "";
      if (content.bhvr && !assigned(overrides.behavior)) {
        behavior = validate(content.bhvr as string | number);
        delete content.bhvr;
      }
      const name = contentName(content.id || content.contentName || NOT_SPECIFIED);
      // Upstream uses parentName here, even though extraction produces parentname.
      const parentId = contentName(content.parentid || content.parentName || NOT_SPECIFIED);
      delete content.id;
      delete content.parentid;
      delete content.parentname;
      if (config.dataTags?.parentDataTag) delete content[config.dataTags.parentDataTag];
      const serialized = JSON.stringify([{ ...content, ...overrides.contentTags }]);
      if (
        config.dropInvalidEvents &&
        name === NOT_SPECIFIED &&
        parentId === NOT_SPECIFIED &&
        serialized === "[{}]"
      )
        return;

      const pageTags = {
        ...config.pageTags,
        ...config.callback?.pageActionPageTags?.(element),
        ...overrides.pageTags,
        metaTags: Object.fromEntries(
          Object.entries(this.#metadata).filter(
            ([key]) => !["behavior", "market", "pageType"].includes(key),
          ),
        ),
      };
      let uri = config.coreData?.requestUri;
      if (!uri && typeof location !== "undefined") {
        uri = location.origin + location.pathname;
        // Preserve the upstream hash-before-query order for compatibility.
        if (config.urlCollectHash) uri += location.hash;
        if (config.urlCollectQuery) uri += location.search;
      }
      this.trackPageAction(
        {
          name,
          parentId,
          uri,
          pageName:
            overrides.pageName ||
            (config.callback?.pageName
              ? config.callback.pageName()
              : config.coreData?.pageName || document.title),
          pageType: overrides.pageType || config.coreData?.pageType || this.#metadata.pageType,
          refUri: assigned(overrides.refUri)
            ? overrides.refUri
            : (config.coreData?.referrerUri ?? document.referrer),
          targetUri: overrides.targetUri ?? targetUri(element),
          behavior,
          actionType: overrides.actionType,
          clickCoordinates:
            assigned(overrides.clickCoordinateX) && assigned(overrides.clickCoordinateY)
              ? `${overrides.clickCoordinateX}X${overrides.clickCoordinateY}`
              : undefined,
          content: serialized,
          timeToAction:
            typeof performance !== "undefined" && performance.timeOrigin
              ? Date.now() - performance.timeOrigin
              : -1,
          properties: { pageTags },
        },
        customProperties,
      );
    });
  }

  /** Emits a supplied page action without DOM extraction or invalid-content filtering. */
  public trackPageAction(
    action: ClickAnalyticsPageAction,
    customProperties: ClickAnalyticsProperties = {},
  ): void {
    if (!this.enabledState) return;
    this.#safely(() => {
      const attributes: NonNullable<LogRecord["attributes"]> = {};
      const fields = {
        "browser.click.name": action.name,
        "url.full": action.uri,
        "browser.page_view.name": action.pageName,
        "browser.click.page_type": action.pageType,
        "url.referrer": action.refUri,
        "browser.click.target_url": action.targetUri,
        "browser.click.action_type": action.actionType,
        "browser.click.behavior": action.behavior,
        "browser.click.coordinates": action.clickCoordinates,
        "browser.click.content": action.content,
        "browser.click.time_to_action": action.timeToAction,
        "browser.click.parent_id": action.parentId,
      };
      for (const [key, value] of Object.entries(fields)) {
        if (assigned(value)) attributes[key] = value;
      }
      attributes["browser.click.properties"] = JSON.stringify({
        ...customProperties,
        ...action.properties,
      });
      const record: LogRecord = {
        eventName: "browser.click",
        severityNumber: SeverityNumber.INFO,
        context: context.active(),
        attributes,
      };
      this.getConfig().applyCustomLogRecordData?.(record);
      // Protect explicit URLs and hook-added values too; DOM content remains application-owned.
      for (const key of ["url.full", "url.referrer", "browser.click.target_url"]) {
        const outputAttributes = record.attributes;
        const url = outputAttributes?.[key];
        if (!outputAttributes || typeof url !== "string" || !url) continue;
        try {
          outputAttributes[key] = redactUrl(url);
        } catch {
          // Upstream permits non-URL strings for explicit page-action fields.
        }
      }
      if (this.enabledState) this.logger.emit(record);
    });
  }

  #captureAutomatic(event: Event): void {
    if (!this.enabledState) return;
    const config = this.getConfig();
    const key = event as KeyboardEvent;
    const mouse = event as MouseEvent;
    const actionType =
      event.type === "keyup"
        ? key.key === "Enter" || key.keyCode === 13
          ? "KE"
          : key.key === " " || key.keyCode === 32
            ? "KS"
            : undefined
        : ["CL", "CM", "CR"][mouse.button];
    if (!actionType) return;
    const elements = new Set(
      (config.trackElementTypes ?? DEFAULT_ELEMENTS.join(","))
        .toUpperCase()
        .split(",")
        .map((tag) => tag.trim()),
    );
    let element = event.target as Element | null;
    while (element?.tagName) {
      const control = (element as HTMLLabelElement).control;
      if (control && elements.has(control.tagName.toUpperCase())) element = control;
      if (!elements.has(element.tagName.toUpperCase())) {
        element = element.parentElement;
        continue;
      }
      if (
        (element.tagName !== "INPUT" || INPUT_TYPES.has((element as HTMLInputElement).type)) &&
        !isDoNotTrack(element, config)
      ) {
        this.capturePageAction(
          element,
          {
            actionType,
            clickCoordinateX: mouse.pageX,
            clickCoordinateY: mouse.pageY,
            isAuto: true,
          },
          {},
          actionType === "CR",
        );
      }
      break;
    }
  }

  #safely(callback: () => void): void {
    try {
      callback();
    } catch {
      // Application callbacks, markup, and telemetry errors must not break user interactions.
      diag.warn("Click analytics could not capture a page action.");
    }
  }
}

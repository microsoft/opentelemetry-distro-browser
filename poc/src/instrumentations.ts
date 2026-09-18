import type { Span } from "@opentelemetry/api";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { ErrorsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/errors";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import { NavigationTimingInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation-timing";
import { ResourceTimingInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/resource-timing";
import { UserActionInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/user-action";
import { WebVitalsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/web-vitals";
import { XhrInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import type { InstanceInstrumentation } from "./multi-instance-provider";

/**
 * How an instrumentation acquires its data decides whether two SDK instances on one page can
 * both run it.
 *
 * - `isolated` observes a browser-owned source (PerformanceObserver, an addEventListener
 *   subscription, or a one-shot read of the performance timeline). The browser multiplexes
 *   these, so N instances each get their own independent feed and nothing is shared.
 * - `shared-patch` replaces a global function. Enabling it twice wraps the first wrapper in the
 *   second, so a single browser operation is observed more than once and the instances become
 *   coupled. This is the case that needs an arbitration policy, and the PoC measures it rather
 *   than assuming an outcome.
 */
export type PatchStrategy = "isolated" | "shared-patch";

export interface InstrumentationDescriptor {
    /** Stable key used in checks and in the size harness scenario list. */
    key: string;
    /** npm package the implementation comes from, or "this repo" when we own it. */
    source: string;
    /** Instrumentation scope name it reports under, used to attribute signals back to it. */
    scopeName: string;
    strategy: PatchStrategy;
    /** Primary signal, which is the thing under debate for browser telemetry. */
    signal: "span" | "log";
    create(instanceName: string): InstanceInstrumentation;
}

const tagSpan = (instanceName: string) => (span: Span): void => {
    span.setAttribute("poc.instance", instanceName);
};

const tagLogRecord = (instanceName: string) => (logRecord: { attributes?: Record<string, unknown> }): void => {
    logRecord.attributes = { ...logRecord.attributes, "poc.instance": instanceName };
};

/**
 * Every instrumentation is constructed disabled. The bridge enables it inside the owning
 * instance's context, after the providers are set, so the tracer and logger it captures are
 * already bound to that instance.
 */
export const INSTRUMENTATIONS: InstrumentationDescriptor[] = [
    {
        key: "navigation-timing",
        source: "@opentelemetry/browser-instrumentation/experimental/navigation-timing",
        scopeName: "@opentelemetry/browser-instrumentation/navigation-timing",
        strategy: "isolated",
        signal: "log",
        create: () => new NavigationTimingInstrumentation({ enabled: false })
    },
    {
        key: "resource-timing",
        source: "@opentelemetry/browser-instrumentation/experimental/resource-timing",
        scopeName: "@opentelemetry/browser-instrumentation/resource-timing",
        strategy: "isolated",
        signal: "log",
        create: () => new ResourceTimingInstrumentation({ enabled: false })
    },
    {
        key: "web-vitals",
        source: "@opentelemetry/browser-instrumentation/experimental/web-vitals",
        scopeName: "@opentelemetry/browser-instrumentation/web-vitals",
        strategy: "isolated",
        signal: "log",
        create: (instanceName) => new WebVitalsInstrumentation({
            enabled: false,
            applyCustomLogRecordData: tagLogRecord(instanceName)
        })
    },
    {
        key: "errors",
        source: "@opentelemetry/browser-instrumentation/experimental/errors",
        scopeName: "@opentelemetry/browser-instrumentation/errors",
        strategy: "isolated",
        signal: "log",
        create: (instanceName) => new ErrorsInstrumentation({
            enabled: false,
            applyCustomAttributes: () => ({ "poc.instance": instanceName })
        })
    },
    {
        key: "user-action",
        source: "@opentelemetry/browser-instrumentation/experimental/user-action",
        scopeName: "@opentelemetry/browser-instrumentation/user-action",
        strategy: "isolated",
        signal: "log",
        create: (instanceName) => new UserActionInstrumentation({
            enabled: false,
            autoCapturedActions: ["click"],
            applyCustomLogRecordData: tagLogRecord(instanceName)
        })
    },
    {
        key: "fetch",
        source: "@opentelemetry/browser-instrumentation/experimental/fetch",
        scopeName: "@opentelemetry/browser-instrumentation/fetch",
        strategy: "shared-patch",
        signal: "span",
        create: (instanceName) => new FetchInstrumentation({
            enabled: false,
            applyCustomAttributesOnSpan: tagSpan(instanceName)
        })
    },
    {
        key: "xhr",
        source: "@opentelemetry/browser-instrumentation/experimental/xhr",
        scopeName: "@opentelemetry/browser-instrumentation/xhr",
        strategy: "shared-patch",
        signal: "span",
        create: (instanceName) => new XhrInstrumentation({
            enabled: false,
            applyCustomAttributesOnSpan: tagSpan(instanceName)
        })
    },
    {
        key: "navigation",
        source: "@opentelemetry/browser-instrumentation/experimental/navigation",
        scopeName: "@opentelemetry/browser-instrumentation/navigation",
        strategy: "shared-patch",
        signal: "log",
        create: (instanceName) => new NavigationInstrumentation({
            enabled: false,
            applyCustomLogRecordData: tagLogRecord(instanceName)
        })
    },
    {
        key: "console",
        source: "@opentelemetry/browser-instrumentation/experimental/console",
        scopeName: "@opentelemetry/browser-instrumentation/console",
        strategy: "shared-patch",
        signal: "log",
        create: () => new ConsoleInstrumentation({
            enabled: false,
            logMethods: ["info"]
        })
    }
];

export const ISOLATED_INSTRUMENTATIONS = INSTRUMENTATIONS.filter((i) => i.strategy === "isolated");
export const SHARED_PATCH_INSTRUMENTATIONS = INSTRUMENTATIONS.filter((i) => i.strategy === "shared-patch");

export function describeInstrumentation(key: string): InstrumentationDescriptor | undefined {
    return INSTRUMENTATIONS.find((i) => i.key === key);
}

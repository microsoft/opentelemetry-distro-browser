import {
    Context,
    ROOT_CONTEXT,
    Span,
    Tracer,
    context,
    propagation,
    trace
} from "@opentelemetry/api";
import { Logger, SeverityNumber, logs } from "@opentelemetry/api-logs";
import { DOCUMENT_URL_ATTRIBUTE, SESSION_ID_ATTRIBUTE } from "./browser-context";
import {
    INSTRUMENTATIONS,
    ISOLATED_INSTRUMENTATIONS,
    SHARED_PATCH_INSTRUMENTATIONS,
    type InstrumentationDescriptor
} from "./instrumentations";
import {
    BridgeDiagnostic,
    MultiInstanceBridge,
    TelemetryInstance,
    installMultiInstanceBridge
} from "./multi-instance-provider";
import "./style.css";

export interface CapturedSpan {
    name: string;
    scope: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    attributes: Record<string, unknown>;
}

export interface CapturedLogRecord {
    eventName?: string;
    scope: string;
    severityNumber?: number;
    attributes: Record<string, unknown>;
}

export interface InstanceSnapshot {
    sessionId: string;
    spans: CapturedSpan[];
    logRecords: CapturedLogRecord[];
}

export interface InstrumentationObservation {
    key: string;
    source: string;
    strategy: string;
    signal: string;
    /** Signals attributed to alpha and to beta, so isolation is visible per instrumentation. */
    alpha: number;
    beta: number;
}

export interface SharedPatchObservation {
    /** Spans produced across all instances for exactly one fetch call. */
    spansForOneRequest: number;
    /** Instances that observed that single request. */
    observedBy: string[];
    /** True when a single browser operation was reported more than once. */
    duplicated: boolean;
}

export interface PocResult {
    passed: boolean;
    alpha: InstanceSnapshot;
    beta: InstanceSnapshot;
    instrumentations: InstrumentationObservation[];
    sharedPatch: SharedPatchObservation;
    diagnostics: BridgeDiagnostic[];
    checks: Record<string, boolean>;
}

declare global {
    interface Window {
        pocResult?: PocResult;
    }
}

const SCOPE_NAME = "rayfin-poc";
const SCOPE_VERSION = "0.0.0";
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function snapshotSpans(instance: TelemetryInstance): CapturedSpan[] {
    return instance.spans.map((span) => ({
        name: span.name,
        scope: span.instrumentationScope.name,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId,
        attributes: { ...span.attributes }
    }));
}

function snapshotLogRecords(instance: TelemetryInstance): CapturedLogRecord[] {
    return instance.logRecords.map((record) => ({
        eventName: record.eventName,
        scope: record.instrumentationScope.name,
        severityNumber: record.severityNumber,
        attributes: { ...record.attributes }
    }));
}

/**
 * Spans stay where correlation is real: an operation and the request it causes. Everything the
 * upstream browser model treats as an occurrence is emitted as an event through the Logs API.
 */
async function runOperation(tracer: Tracer, logger: Logger, instanceName: string, pause: number): Promise<void> {
    logger.emit({
        eventName: "browser.user_action.click",
        severityNumber: SeverityNumber.INFO,
        attributes: { "instance.id": instanceName, "app.element": `${instanceName}-button` }
    });

    const operationSpan = tracer.startSpan(`${instanceName}.operation`);
    operationSpan.setAttribute("instance.id", instanceName);
    const operationContext: Context = trace.setSpan(context.active(), operationSpan);

    await delay(pause);

    const httpSpan = tracer.startSpan(`${instanceName}.http`, {
        attributes: { "http.request.method": "POST" }
    }, operationContext);
    await delay(1);
    httpSpan.end();
    operationSpan.end();

    logger.emit({
        eventName: "browser.web_vital",
        severityNumber: SeverityNumber.INFO,
        attributes: { "instance.id": instanceName, "browser.web_vital.name": "LCP", "browser.web_vital.value": pause }
    });
    logger.emit({
        eventName: "exception",
        severityNumber: SeverityNumber.ERROR,
        attributes: { "instance.id": instanceName, "exception.type": "DemoError" }
    });
}

function hasCorrectParent(spans: CapturedSpan[], instanceName: string): boolean {
    const root = spans.find((span) => span.name === `${instanceName}.operation`);
    const child = spans.find((span) => span.name === `${instanceName}.http`);
    return !!root && !!child && child.parentSpanId === root.spanId && child.traceId === root.traceId;
}

/**
 * Alpha runs everything. Beta runs only the instrumentations that observe a browser-owned
 * source, because the global-patching ones cannot be enabled twice without the second
 * enable wrapping the first. Assigning a single owner is the arbitration policy under test.
 */
function installInstrumentations(
    bridge: MultiInstanceBridge,
    instance: TelemetryInstance,
    descriptors: InstrumentationDescriptor[]
): void {
    for (const descriptor of descriptors) {
        bridge.initializeInstrumentation(instance, () => descriptor.create(instance.id));
    }
}

/**
 * Drives one of every instrumented browser operation. Each is a real operation rather than a
 * synthetic emit, so the spans and events come from the upstream instrumentation code paths.
 */
async function triggerBrowserActivity(tracer: Tracer): Promise<void> {
    const requestParent = tracer.startSpan("alpha.instrumented-request-parent");
    const requestContext = trace.setSpan(context.active(), requestParent);

    // fetch
    await context.with(requestContext, () => fetch("/index.html?probe=fetch"))
        .then((response) => response.text());

    // XMLHttpRequest
    await context.with(requestContext, () => new Promise<void>((resolve) => {
        const request = new XMLHttpRequest();
        request.addEventListener("loadend", () => resolve());
        request.open("GET", "/index.html?probe=xhr");
        request.send();
    }));
    requestParent.end();

    // user action, captured by a document-level listener in each isolated instance
    document.querySelector<HTMLButtonElement>("[data-probe-click]")?.click();

    // history navigation
    history.pushState({}, "", "/?probe=navigation");
    history.replaceState({}, "", "/");

    // console
    console.info("poc probe console");

    // unhandled error, delivered the way the browser delivers one
    window.dispatchEvent(new ErrorEvent("error", {
        message: "poc probe error",
        error: new Error("poc probe error")
    }));

    // The fetch and XHR instrumentations do not end their spans on response. They wait
    // OBSERVER_WAIT_TIME_MS (300ms upstream) for the PerformanceResourceTiming entry so they can
    // attach network events. Nothing is exported before that elapses.
    await delay(500);
}

/**
 * Measures what actually happens when two instances both enable a global-patching
 * instrumentation. The result is recorded as data rather than asserted against a guess.
 */
async function measureSharedPatchBehaviour(
    bridge: MultiInstanceBridge,
    owner: TelemetryInstance
): Promise<SharedPatchObservation> {
    const second = bridge.createInstance("gamma");
    const fetchDescriptor = SHARED_PATCH_INSTRUMENTATIONS.find((i) => i.key === "fetch")!;
    installInstrumentations(bridge, second, [fetchDescriptor]);

    const probeUrl = "/index.html?probe=shared-patch";
    await fetch(probeUrl).then((response) => response.text());
    await delay(500);
    await Promise.all([owner.forceFlush(), second.forceFlush()]);

    const matches = (instance: TelemetryInstance) => instance.spans
        .filter((span) => String(span.attributes["url.full"] ?? span.attributes["http.url"] ?? "")
            .includes("probe=shared-patch"));

    const ownerSpans = matches(owner);
    const secondSpans = matches(second);
    const observedBy: string[] = [];
    if (ownerSpans.length > 0) {
        observedBy.push(owner.id);
    }
    if (secondSpans.length > 0) {
        observedBy.push(second.id);
    }

    const spansForOneRequest = ownerSpans.length + secondSpans.length;
    await second.shutdown();

    return {
        spansForOneRequest,
        observedBy,
        duplicated: spansForOneRequest > 1
    };
}

function observeInstrumentations(alpha: InstanceSnapshot, beta: InstanceSnapshot): InstrumentationObservation[] {
    const countFor = (snapshot: InstanceSnapshot, descriptor: InstrumentationDescriptor): number => {
        const carriers: Array<{ scope: string }> = descriptor.signal === "span"
            ? snapshot.spans
            : snapshot.logRecords;
        return carriers.filter((carrier) => carrier.scope === descriptor.scopeName).length;
    };

    return INSTRUMENTATIONS.map((descriptor) => ({
        key: descriptor.key,
        source: descriptor.source,
        strategy: descriptor.strategy,
        signal: descriptor.signal,
        alpha: countFor(alpha, descriptor),
        beta: countFor(beta, descriptor)
    }));
}

async function waitForExportedSpan(instance: TelemetryInstance, name: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        await instance.forceFlush();
        if (instance.spans.some((span) => span.name === name)) {
            return;
        }
        await delay(10);
    }
    throw new Error(`Timed out waiting for '${name}' instrumentation span in instance '${instance.id}'`);
}

async function waitForExportedLogRecord(instance: TelemetryInstance, eventName: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        await instance.forceFlush();
        if (instance.logRecords.some((record) => record.eventName === eventName)) {
            return;
        }
        await delay(10);
    }
    throw new Error(`Timed out waiting for '${eventName}' instrumentation log in instance '${instance.id}'`);
}

/**
 * Browsers have no ambient async context, so outbound correlation is proven the way a real
 * fetch instrumentation would do it: inject from an explicit context, extract on the far side.
 */
function checkPropagation(tracer: Tracer): { traceContext: boolean; baggage: boolean } {
    const span = tracer.startSpan("alpha.propagation");
    const outbound = propagation.setBaggage(
        trace.setSpan(ROOT_CONTEXT, span),
        propagation.createBaggage({ "app.tenant": { value: "alpha" } })
    );
    const carrier: Record<string, string> = {};
    propagation.inject(outbound, carrier);
    span.end();

    const extracted = propagation.extract(ROOT_CONTEXT, carrier);
    const extractedSpanContext = trace.getSpanContext(extracted);
    const extractedBaggage = propagation.getBaggage(extracted);

    return {
        traceContext: !!carrier.traceparent
            && extractedSpanContext?.traceId === span.spanContext().traceId
            && extractedSpanContext?.spanId === span.spanContext().spanId,
        baggage: carrier.baggage?.includes("app.tenant=alpha") === true
            && extractedBaggage?.getEntry("app.tenant")?.value === "alpha"
    };
}

function carriesBrowserContext(
    spans: CapturedSpan[],
    logRecords: CapturedLogRecord[],
    sessionId: string
): boolean {
    const carriers = [...spans, ...logRecords];
    return carriers.length > 0 && carriers.every((carrier) =>
        carrier.attributes[SESSION_ID_ATTRIBUTE] === sessionId
        && typeof carrier.attributes[DOCUMENT_URL_ATTRIBUTE] === "string");
}

export async function runPoc(): Promise<PocResult> {
    const diagnostics: BridgeDiagnostic[] = [];
    const bridge = installMultiInstanceBridge({ onDiagnostic: (d) => diagnostics.push(d) });
    const alpha = bridge.createInstance("alpha");
    const beta = bridge.createInstance("beta");

    // Alpha owns the global patches; both instances observe the browser-owned sources.
    installInstrumentations(bridge, alpha, INSTRUMENTATIONS);
    installInstrumentations(bridge, beta, ISOLATED_INSTRUMENTATIONS);

    // Registered after enable() so the old user-interaction patch would have seen it too.
    // The new user-action instrumentation is simpler: it listens on document in capture phase.
    document.querySelector<HTMLButtonElement>("[data-probe-click]")
        ?.addEventListener("click", () => undefined);

    const alphaTracer = bridge.runWithInstance(alpha, () => trace.getTracer(SCOPE_NAME, SCOPE_VERSION));
    const betaTracer = bridge.runWithInstance(beta, () => trace.getTracer(SCOPE_NAME, SCOPE_VERSION));
    const alphaLogger = bridge.runWithInstance(alpha, () => logs.getLogger(SCOPE_NAME, SCOPE_VERSION));
    const betaLogger = bridge.runWithInstance(beta, () => logs.getLogger(SCOPE_NAME, SCOPE_VERSION));

    await triggerBrowserActivity(alphaTracer);

    await Promise.all([
        runOperation(alphaTracer, alphaLogger, "alpha", 15),
        runOperation(betaTracer, betaLogger, "beta", 5)
    ]);

    // Batch processors hold everything until an explicit flush, so this is the moment that proves
    // per-instance forceFlush() is doing real work rather than reading a synchronous buffer.
    const bufferedBeforeFlush = alpha.spans.length === 0
        && beta.spans.length === 0
        && alpha.logRecords.length === 0
        && beta.logRecords.length === 0;

    const propagationChecks = checkPropagation(alphaTracer);

    await Promise.all([
        waitForExportedSpan(alpha, "GET"),
        waitForExportedLogRecord(alpha, "browser.navigation_timing"),
        waitForExportedLogRecord(beta, "browser.navigation_timing"),
        waitForExportedLogRecord(alpha, "browser.resource_timing"),
        waitForExportedLogRecord(beta, "browser.resource_timing"),
        waitForExportedLogRecord(alpha, "browser.user_action.click"),
        waitForExportedLogRecord(beta, "browser.user_action.click"),
        waitForExportedLogRecord(alpha, "browser.web_vital"),
        waitForExportedLogRecord(beta, "browser.web_vital")
    ]);
    await Promise.all([alpha.forceFlush(), beta.forceFlush()]);

    const alphaSnapshot: InstanceSnapshot = {
        sessionId: alpha.sessionId,
        spans: snapshotSpans(alpha),
        logRecords: snapshotLogRecords(alpha)
    };
    const betaSnapshot: InstanceSnapshot = {
        sessionId: beta.sessionId,
        spans: snapshotSpans(beta),
        logRecords: snapshotLogRecords(beta)
    };

    const alphaApplicationSpans = alphaSnapshot.spans.filter((span) => span.scope === SCOPE_NAME);
    const betaApplicationSpans = betaSnapshot.spans.filter((span) => span.scope === SCOPE_NAME);
    const alphaApplicationLogRecords = alphaSnapshot.logRecords.filter((record) => record.scope === SCOPE_NAME);
    const betaApplicationLogRecords = betaSnapshot.logRecords.filter((record) => record.scope === SCOPE_NAME);

    const instrumentations = observeInstrumentations(alphaSnapshot, betaSnapshot);
    const observationFor = (key: string): InstrumentationObservation =>
        instrumentations.find((observation) => observation.key === key)!;

    // Run last against the live instances so its spans stay out of the snapshots above.
    const sharedPatch = await measureSharedPatchBehaviour(bridge, alpha);

    // A second bridge must observe the globals it does not own and refuse to overwrite them.
    const conflictingBridge = installMultiInstanceBridge();
    const conflictCodes = conflictingBridge.diagnostics.map((d) => d.code);

    await alpha.shutdown();
    await alpha.shutdown();
    const staleSpanAfterShutdown = alphaTracer.startSpan("alpha.after-shutdown");
    staleSpanAfterShutdown.end();
    alphaLogger.emit({ eventName: "browser.user_action.click", severityNumber: SeverityNumber.INFO });
    const staleDiagnostics = diagnostics.filter((d) => d.code === "telemetry-after-shutdown");

    // Beta must keep working after Alpha is gone.
    betaTracer.startSpan("beta.after-alpha-shutdown").end();
    await beta.forceFlush();
    const betaSurvivedAlphaShutdown = beta.spans.some((span) => span.name === "beta.after-alpha-shutdown");

    const checks = {
        alphaIsolated: alphaApplicationSpans.length === 4,
        betaIsolated: betaApplicationSpans.length === 2,
        alphaAsyncParent: hasCorrectParent(alphaSnapshot.spans, "alpha"),
        betaAsyncParent: hasCorrectParent(betaSnapshot.spans, "beta"),
        upstreamInstrumentationRouted: instrumentations.every((observation) => {
            if (observation.strategy === "isolated") {
                return observation.alpha > 0 && observation.beta > 0;
            }
            return observation.alpha > 0 && observation.beta === 0;
        }),
        upstreamInstrumentationParentage: (() => {
            const parent = alphaSnapshot.spans.find((span) => span.name === "alpha.instrumented-request-parent");
            const requestSpans = alphaSnapshot.spans
                .filter((span) => ["@opentelemetry/browser-instrumentation/fetch", "@opentelemetry/browser-instrumentation/xhr"]
                    .includes(span.scope));
            return !!parent && requestSpans.length >= 2 && requestSpans.every((span) =>
                span.parentSpanId === parent.spanId
                && span.traceId === parent.traceId
                && span.attributes["poc.instance"] === "alpha");
        })(),
        // Instrumentations that observe a browser-owned source can run in every instance at once.
        isolatedInstrumentationsRunInEveryInstance: ISOLATED_INSTRUMENTATIONS
            .every((descriptor) => {
                const observation = observationFor(descriptor.key);
                return observation.alpha > 0 && observation.beta > 0;
            }),
        // Instrumentations that patch a global are assigned one owner, so only alpha reports them.
        sharedPatchInstrumentationsHaveSingleOwner: SHARED_PATCH_INSTRUMENTATIONS
            .every((descriptor) => {
                const observation = observationFor(descriptor.key);
                return observation.alpha > 0 && observation.beta === 0;
            }),
        // Documents why that ownership rule is needed: without it one request is reported twice.
        sharedPatchDuplicatesWithoutArbitration: sharedPatch.duplicated
            && sharedPatch.observedBy.length === 2,
        alphaEventsIsolated: alphaApplicationLogRecords.length === 3
            && alphaApplicationLogRecords.every((record) => record.attributes["instance.id"] === "alpha"),
        betaEventsIsolated: betaApplicationLogRecords.length === 3
            && betaApplicationLogRecords.every((record) => record.attributes["instance.id"] === "beta"),
        eventsUseTopLevelEventName: [...alphaSnapshot.logRecords, ...betaSnapshot.logRecords]
            .every((record) => typeof record.eventName === "string" && record.eventName.length > 0),
        browserContextOnBothSignals:
            carriesBrowserContext(alphaSnapshot.spans, alphaSnapshot.logRecords, alpha.sessionId)
            && carriesBrowserContext(betaSnapshot.spans, betaSnapshot.logRecords, beta.sessionId)
            && alpha.sessionId !== beta.sessionId,
        w3cTraceContextRoundTrip: propagationChecks.traceContext,
        baggageRoundTrip: propagationChecks.baggage,
        forceFlushControlsExport: bufferedBeforeFlush
            && alphaSnapshot.spans.length > 0
            && alphaSnapshot.logRecords.length > 0,
        staleTracerAndLoggerAreInert: !staleSpanAfterShutdown.isRecording()
            && staleSpanAfterShutdown.spanContext().traceId === "0".repeat(32)
            && staleDiagnostics.length === 2,
        shutdownIsIdempotent: alpha.state === "shutdown" && betaSurvivedAlphaShutdown,
        globalOwnershipConflictReported: !conflictingBridge.ownsGlobals
            && conflictCodes.includes("tracer-provider-conflict")
            && conflictCodes.includes("logger-provider-conflict")
            && conflictCodes.includes("context-manager-conflict")
            && conflictCodes.includes("propagator-conflict")
    };

    const result: PocResult = {
        passed: Object.values(checks).every(Boolean),
        alpha: alphaSnapshot,
        beta: betaSnapshot,
        instrumentations,
        sharedPatch,
        diagnostics,
        checks
    };

    await bridge.shutdown();
    return result;
}

function render(result: PocResult): void {
    const status = document.querySelector<HTMLElement>("[data-status]");
    const output = document.querySelector<HTMLElement>("[data-output]");
    if (status) {
        status.textContent = result.passed ? "PASS" : "FAIL";
        status.dataset.passed = String(result.passed);
    }
    if (output) {
        output.textContent = JSON.stringify(result, null, 2);
    }
}

runPoc().then((result) => {
    window.pocResult = result;
    render(result);
}).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    const output = document.querySelector<HTMLElement>("[data-output]");
    if (output) {
        output.textContent = message;
    }
});

import { Context, Span, Tracer, context, trace } from "@opentelemetry/api";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { installMultiInstanceBridge, RecordedSpan } from "./multi-instance-provider";
import "./style.css";

export interface PocResult {
    passed: boolean;
    alpha: RecordedSpan[];
    beta: RecordedSpan[];
    checks: Record<string, boolean>;
}

declare global {
    interface Window {
        pocResult?: PocResult;
    }
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runOperation(tracer: Tracer, instanceName: string, pause: number): Promise<void> {
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
}

function hasCorrectParent(spans: RecordedSpan[], instanceName: string): boolean {
    const root = spans.find((span) => span.name === `${instanceName}.operation`);
    const child = spans.find((span) => span.name === `${instanceName}.http`);
    return !!root && !!child && child.parentSpanId === root.spanId && child.traceId === root.traceId;
}

function hasDocumentLoadParentage(spans: RecordedSpan[]): boolean {
    const root = spans.find((span) => span.name === "documentLoad");
    const fetch = spans.find((span) => span.name === "documentFetch");
    return !!root && !!fetch && fetch.parentSpanId === root.spanId && fetch.traceId === root.traceId;
}

function createDocumentLoadInstrumentation(instanceName: string): DocumentLoadInstrumentation {
    const tagInstance = (span: Span) => span.setAttribute("poc.instance", instanceName);
    return new DocumentLoadInstrumentation({
        enabled: false,
        applyCustomAttributesOnSpan: {
            documentLoad: tagInstance,
            documentFetch: tagInstance,
            resourceFetch: tagInstance
        }
    });
}

async function waitForSpan(spans: RecordedSpan[], name: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (spans.some((span) => span.name === name)) {
            return;
        }
        await delay(10);
    }
    throw new Error(`Timed out waiting for '${name}' instrumentation span`);
}

export async function runPoc(): Promise<PocResult> {
    const bridge = installMultiInstanceBridge();
    const alpha = bridge.createInstance("alpha");
    const beta = bridge.createInstance("beta");
    bridge.initializeInstrumentation(alpha, () => createDocumentLoadInstrumentation("alpha"));
    bridge.initializeInstrumentation(beta, () => createDocumentLoadInstrumentation("beta"));
    const alphaTracer = bridge.runWithInstance(alpha, () => trace.getTracer("rayfin-poc", "0.0.0"));
    const betaTracer = bridge.runWithInstance(beta, () => trace.getTracer("rayfin-poc", "0.0.0"));

    await Promise.all([
        runOperation(alphaTracer, "alpha", 15),
        runOperation(betaTracer, "beta", 5)
    ]);
    await Promise.all([
        waitForSpan(alpha.spans, "documentLoad"),
        waitForSpan(beta.spans, "documentLoad")
    ]);

    const alphaSpans = alpha.spans.slice();
    const betaSpans = beta.spans.slice();
    const alphaApplicationSpans = alphaSpans.filter((span) => span.name.startsWith("alpha."));
    const betaApplicationSpans = betaSpans.filter((span) => span.name.startsWith("beta."));
    const alphaInstrumentationSpans = alphaSpans.filter((span) => !span.name.startsWith("alpha."));
    const betaInstrumentationSpans = betaSpans.filter((span) => !span.name.startsWith("beta."));
    const checks = {
        alphaIsolated: alphaApplicationSpans.length === 2,
        betaIsolated: betaApplicationSpans.length === 2,
        alphaAsyncParent: hasCorrectParent(alphaSpans, "alpha"),
        betaAsyncParent: hasCorrectParent(betaSpans, "beta"),
        upstreamInstrumentationRouted: alphaInstrumentationSpans.length > 0
            && betaInstrumentationSpans.length > 0
            && alphaInstrumentationSpans.every((span) => span.attributes["poc.instance"] === "alpha")
            && betaInstrumentationSpans.every((span) => span.attributes["poc.instance"] === "beta"),
        upstreamInstrumentationParentage: hasDocumentLoadParentage(alphaInstrumentationSpans)
            && hasDocumentLoadParentage(betaInstrumentationSpans)
    };
    const result = {
        passed: Object.values(checks).every(Boolean),
        alpha: alphaSpans,
        beta: betaSpans,
        checks
    };

    bridge.shutdown();
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
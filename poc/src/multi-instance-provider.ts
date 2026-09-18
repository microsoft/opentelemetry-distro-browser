import {
    Context,
    ContextManager,
    Span,
    SpanOptions,
    TextMapPropagator,
    Tracer,
    TracerOptions,
    TracerProvider,
    INVALID_SPAN_CONTEXT,
    context,
    createContextKey,
    propagation,
    trace
} from "@opentelemetry/api";
import {
    Logger,
    LoggerOptions,
    LoggerProvider,
    LogRecord,
    SeverityNumber,
    logs
} from "@opentelemetry/api-logs";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import {
    BatchLogRecordProcessor,
    InMemoryLogRecordExporter,
    LoggerProvider as SdkLoggerProvider,
    type ReadableLogRecord
} from "@opentelemetry/sdk-logs";
import {
    BasicTracerProvider,
    BatchSpanProcessor,
    InMemorySpanExporter,
    type ReadableSpan
} from "@opentelemetry/sdk-trace-base";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
    BrowserContextLogRecordProcessor,
    BrowserContextSpanProcessor,
    type BrowserContextSource
} from "./browser-context";

export type InstanceState = "started" | "shutdown";

export interface TelemetryInstance {
    readonly id: string;
    readonly sessionId: string;
    readonly state: InstanceState;
    /** Spans handed to this instance's own exporter. */
    readonly spans: ReadableSpan[];
    /** Log records handed to this instance's own exporter. */
    readonly logRecords: ReadableLogRecord[];
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
}

export interface InstanceInstrumentation {
    setTracerProvider(tracerProvider: TracerProvider): void;
    setLoggerProvider?(loggerProvider: LoggerProvider): void;
    enable(): void;
    disable(): void;
}

export type BridgeDiagnosticCode =
    | "context-manager-conflict"
    | "tracer-provider-conflict"
    | "logger-provider-conflict"
    | "propagator-conflict"
    | "telemetry-after-shutdown";

export interface BridgeDiagnostic {
    code: BridgeDiagnosticCode;
    message: string;
}

export interface BridgeOptions {
    onDiagnostic?(diagnostic: BridgeDiagnostic): void;
}

export interface MultiInstanceBridge {
    /** False when another OTel SDK already owned a global; the bridge never overwrites it. */
    readonly ownsGlobals: boolean;
    readonly diagnostics: readonly BridgeDiagnostic[];
    createInstance(id: string): TelemetryInstance;
    getInstance(id: string): TelemetryInstance | undefined;
    runWithInstance<T>(instance: TelemetryInstance, callback: () => T): T;
    initializeInstrumentation<T extends InstanceInstrumentation>(
        instance: TelemetryInstance,
        factory: () => T
    ): T;
    shutdown(): Promise<void>;
}

const INSTANCE_KEY = createContextKey("microsoft.otel.instance");

function randomHex(bytes: number): string {
    const webCrypto = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    const values = new Uint8Array(bytes);

    if (webCrypto?.getRandomValues) {
        webCrypto.getRandomValues(values);
    } else {
        // Demonstration fallback when Web Crypto is unavailable. Production code must inject
        // a stronger ID generator and should not claim cryptographic randomness here.
        for (let index = 0; index < bytes; index++) {
            values[index] = Math.floor(Math.random() * 256);
        }
    }

    let result = "";
    for (const value of values) {
        result += value.toString(16).padStart(2, "0");
    }
    return result;
}

/**
 * One instance owns two isolated upstream pipelines: a tracer provider and a logger provider,
 * each with its own batch processor and exporter. Nothing is shared between instances except
 * the single set of global OTel registrations the bridge owns.
 */
class Instance implements TelemetryInstance, BrowserContextSource {
    public readonly sessionId = randomHex(8);
    public state: InstanceState = "started";
    public readonly spanExporter = new InMemorySpanExporter();
    public readonly logRecordExporter = new InMemoryLogRecordExporter();
    public readonly tracerProvider: BasicTracerProvider;
    public readonly loggerProvider: SdkLoggerProvider;
    public readonly instrumentations: InstanceInstrumentation[] = [];
    private readonly tracers = new Map<string, Tracer>();
    private readonly loggers = new Map<string, Logger>();
    private shutdownPromise?: Promise<void>;

    public constructor(public readonly id: string) {
        const resource = resourceFromAttributes({ "service.name": id });
        this.tracerProvider = new BasicTracerProvider({
            resource,
            spanProcessors: [
                new BrowserContextSpanProcessor(this),
                new BatchSpanProcessor(this.spanExporter, { scheduledDelayMillis: 30000 })
            ]
        });
        this.loggerProvider = new SdkLoggerProvider({
            resource,
            processors: [
                new BrowserContextLogRecordProcessor(this),
                new BatchLogRecordProcessor({
                    exporter: this.logRecordExporter,
                    scheduledDelayMillis: 30000
                })
            ]
        });
    }

    public documentUrl(): string {
        return typeof document !== "undefined" ? document.location.href : "";
    }

    public get spans(): ReadableSpan[] {
        return this.spanExporter.getFinishedSpans();
    }

    public get logRecords(): ReadableLogRecord[] {
        return this.logRecordExporter.getFinishedLogRecords();
    }

    public tracer(name: string, version?: string, options?: TracerOptions): Tracer {
        const key = `${name}@${version ?? ""}@${options?.schemaUrl ?? ""}`;
        let tracer = this.tracers.get(key);
        if (!tracer) {
            tracer = this.tracerProvider.getTracer(name, version, options);
            this.tracers.set(key, tracer);
        }
        return tracer;
    }

    public logger(name: string, version?: string, options?: LoggerOptions): Logger {
        const key = `${name}@${version ?? ""}@${options?.schemaUrl ?? ""}`;
        let logger = this.loggers.get(key);
        if (!logger) {
            logger = this.loggerProvider.getLogger(name, version, options);
            this.loggers.set(key, logger);
        }
        return logger;
    }

    public async forceFlush(): Promise<void> {
        if (this.state === "shutdown") {
            return;
        }
        await Promise.all([this.tracerProvider.forceFlush(), this.loggerProvider.forceFlush()]);
    }

    public shutdown(): Promise<void> {
        if (!this.shutdownPromise) {
            this.state = "shutdown";
            this.shutdownPromise = (async () => {
                for (const instrumentation of this.instrumentations.splice(0)) {
                    instrumentation.disable();
                }
                await Promise.all([this.tracerProvider.shutdown(), this.loggerProvider.shutdown()]);
            })();
        }
        return this.shutdownPromise;
    }
}

/**
 * A tracer is bound to its instance at acquisition time and never re-resolves routing, so span
 * creation does not depend on mutable global state. Once the instance is shut down the bound
 * tracer becomes non-recording instead of writing into a torn-down pipeline.
 */
class BoundTracer implements Tracer {
    public constructor(
        private readonly instance: Instance,
        private readonly name: string,
        private readonly version: string | undefined,
        private readonly options: TracerOptions | undefined,
        private readonly onStale: (instance: Instance) => void
    ) {
    }

    public startSpan(name: string, options?: SpanOptions, activeContext?: Context): Span {
        if (this.instance.state === "shutdown") {
            this.onStale(this.instance);
            return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
        }
        return this.delegate().startSpan(name, options, activeContext);
    }

    public startActiveSpan<F extends (span: Span) => unknown>(name: string, callback: F): ReturnType<F>;
    public startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, callback: F): ReturnType<F>;
    public startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, activeContext: Context, callback: F): ReturnType<F>;
    public startActiveSpan<F extends (span: Span) => unknown>(
        name: string,
        optionsOrCallback: SpanOptions | F,
        contextOrCallback?: Context | F,
        callback?: F
    ): ReturnType<F> {
        const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
        const parentContext = contextOrCallback && typeof contextOrCallback !== "function"
            ? contextOrCallback
            : context.active();
        const activeCallback = (typeof optionsOrCallback === "function"
            ? optionsOrCallback
            : typeof contextOrCallback === "function"
                ? contextOrCallback
                : callback) as F;
        const span = this.startSpan(name, options, parentContext);
        return context.with(
            trace.setSpan(parentContext, span),
            (activeSpan: Span): ReturnType<F> => activeCallback(activeSpan) as ReturnType<F>,
            undefined,
            span
        );
    }

    private delegate(): Tracer {
        return this.instance.tracer(this.name, this.version, this.options);
    }
}

/**
 * The logger equivalent of {@link BoundTracer}. Events are the primary browser signal, so the
 * same binding and stale rules have to hold for the Logs API.
 */
class BoundLogger implements Logger {
    public constructor(
        private readonly instance: Instance,
        private readonly name: string,
        private readonly version: string | undefined,
        private readonly options: LoggerOptions | undefined,
        private readonly onStale: (instance: Instance) => void
    ) {
    }

    public emit(logRecord: LogRecord): void {
        if (this.instance.state === "shutdown") {
            this.onStale(this.instance);
            return;
        }
        this.delegate().emit(logRecord);
    }

    public enabled(options?: { context?: Context; severityNumber?: SeverityNumber; eventName?: string }): boolean {
        if (this.instance.state === "shutdown") {
            return false;
        }
        return this.delegate().enabled(options);
    }

    private delegate(): Logger {
        return this.instance.logger(this.name, this.version, this.options);
    }
}

const NOOP_LOGGER: Logger = {
    emit(): void {
    },
    enabled(): boolean {
        return false;
    }
};

/** Returned when a tracer is acquired outside any instance boundary. */
const NOOP_TRACER: Tracer = {
    startSpan(): Span {
        return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    },
    startActiveSpan<F extends (span: Span) => unknown>(
        _name: string,
        optionsOrCallback: SpanOptions | F,
        contextOrCallback?: Context | F,
        callback?: F
    ): ReturnType<F> {
        const activeCallback = (typeof optionsOrCallback === "function"
            ? optionsOrCallback
            : typeof contextOrCallback === "function"
                ? contextOrCallback
                : callback) as F;
        return activeCallback(trace.wrapSpanContext(INVALID_SPAN_CONTEXT)) as ReturnType<F>;
    }
};

class RoutingTracerProvider implements TracerProvider {
    public constructor(
        private readonly resolve: () => Instance | undefined,
        private readonly onStale: (instance: Instance) => void
    ) {
    }

    public getTracer(name: string, version?: string, options?: TracerOptions): Tracer {
        const instance = this.resolve();
        if (!instance) {
            return NOOP_TRACER;
        }
        return new BoundTracer(instance, name, version, options, this.onStale);
    }
}

class RoutingLoggerProvider implements LoggerProvider {
    public constructor(
        private readonly resolve: () => Instance | undefined,
        private readonly onStale: (instance: Instance) => void
    ) {
    }

    public getLogger(name: string, version?: string, options?: LoggerOptions): Logger {
        const instance = this.resolve();
        if (!instance) {
            return NOOP_LOGGER;
        }
        return new BoundLogger(instance, name, version, options, this.onStale);
    }
}

export function installMultiInstanceBridge(options: BridgeOptions = {}): MultiInstanceBridge {
    const instances = new Map<string, Instance>();
    const diagnostics: BridgeDiagnostic[] = [];
    const report = (code: BridgeDiagnosticCode, message: string): void => {
        const diagnostic = { code, message };
        diagnostics.push(diagnostic);
        options.onDiagnostic?.(diagnostic);
    };
    const onStale = (instance: Instance): void => {
        report(
            "telemetry-after-shutdown",
            `Telemetry was dropped because instance '${instance.id}' is already shut down`
        );
    };
    const resolve = (): Instance | undefined => {
        const instanceId = context.active().getValue(INSTANCE_KEY);
        return typeof instanceId === "string" ? instances.get(instanceId) : undefined;
    };

    const contextManager: ContextManager = new StackContextManager().enable();
    const propagator: TextMapPropagator = new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()]
    });

    // Never overwrite another SDK's globals. Report the conflict and keep running in a degraded
    // mode so the host page can decide what to do.
    const ownsContext = context.setGlobalContextManager(contextManager);
    if (!ownsContext) {
        report("context-manager-conflict", "An OpenTelemetry ContextManager is already registered");
    }
    const ownsTracer = trace.setGlobalTracerProvider(new RoutingTracerProvider(resolve, onStale));
    if (!ownsTracer) {
        report("tracer-provider-conflict", "An OpenTelemetry TracerProvider is already registered");
    }
    const routingLoggerProvider = new RoutingLoggerProvider(resolve, onStale);
    const ownsLogger = logs.setGlobalLoggerProvider(routingLoggerProvider) === routingLoggerProvider;
    if (!ownsLogger) {
        report("logger-provider-conflict", "An OpenTelemetry LoggerProvider is already registered");
    }
    const ownsPropagator = propagation.setGlobalPropagator(propagator);
    if (!ownsPropagator) {
        report("propagator-conflict", "An OpenTelemetry TextMapPropagator is already registered");
    }
    const ownsGlobals = ownsContext && ownsTracer && ownsLogger && ownsPropagator;

    const runWithInstance = <T>(instance: TelemetryInstance, callback: () => T): T => {
        if (instances.get(instance.id) !== instance) {
            throw new Error(`Telemetry instance '${instance.id}' is not registered`);
        }
        return context.with(context.active().setValue(INSTANCE_KEY, instance.id), callback);
    };

    return {
        ownsGlobals,
        diagnostics,
        createInstance(id: string): TelemetryInstance {
            if (instances.has(id)) {
                throw new Error(`Telemetry instance '${id}' already exists`);
            }

            const instance = new Instance(id);
            instances.set(id, instance);
            return instance;
        },
        getInstance(id: string): TelemetryInstance | undefined {
            return instances.get(id);
        },
        runWithInstance<T>(instance: TelemetryInstance, callback: () => T): T {
            return runWithInstance(instance, callback);
        },
        initializeInstrumentation<T extends InstanceInstrumentation>(
            instance: TelemetryInstance,
            factory: () => T
        ): T {
            return runWithInstance(instance, () => {
                const instrumentation = factory();
                instrumentation.setTracerProvider(trace.getTracerProvider());
                instrumentation.setLoggerProvider?.(logs.getLoggerProvider());
                instrumentation.enable();

                (instances.get(instance.id) as Instance).instrumentations.push(instrumentation);
                return instrumentation;
            });
        },
        async shutdown(): Promise<void> {
            await Promise.all([...instances.values()].map((instance) => instance.shutdown()));
            instances.clear();
            if (ownsTracer) {
                trace.disable();
            }
            if (ownsLogger) {
                logs.disable();
            }
            if (ownsPropagator) {
                propagation.disable();
            }
            if (ownsContext) {
                context.disable();
            }
        }
    };
}

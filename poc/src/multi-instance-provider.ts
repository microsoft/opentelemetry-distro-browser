import {
    Attributes,
    Context,
    ContextManager,
    Exception,
    Link,
    Span,
    SpanContext,
    SpanOptions,
    SpanStatus,
    TimeInput,
    TraceFlags,
    Tracer,
    TracerOptions,
    TracerProvider,
    ROOT_CONTEXT,
    context,
    createContextKey,
    trace
} from "@opentelemetry/api";

export interface RecordedSpan {
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    attributes: Attributes;
}

export interface TelemetryInstance {
    id: string;
    spans: RecordedSpan[];
}

export interface InstanceInstrumentation {
    setTracerProvider(tracerProvider: TracerProvider): void;
    enable(): void;
    disable(): void;
}

export interface MultiInstanceBridge {
    createInstance(id: string): TelemetryInstance;
    runWithInstance<T>(instance: TelemetryInstance, callback: () => T): T;
    initializeInstrumentation<T extends InstanceInstrumentation>(
        instance: TelemetryInstance,
        factory: () => T
    ): T;
    shutdown(): void;
}

interface SpanStart {
    name: string;
    parent?: SpanContext;
    attributes?: Attributes;
}

const INSTANCE_KEY = createContextKey("microsoft.otel.instance");

function randomHex(bytes: number): string {
    const values: number[] = [];
    const webCrypto = typeof window !== "undefined"
        ? (window.crypto || (window as typeof window & { msCrypto?: Crypto }).msCrypto)
        : undefined;

    if (webCrypto?.getRandomValues && typeof Uint8Array !== "undefined") {
        const randomValues = webCrypto.getRandomValues(new Uint8Array(bytes));
        for (let index = 0; index < randomValues.length; index++) {
            values.push(randomValues[index]);
        }
    } else {
        // Demonstration fallback when Web Crypto is unavailable. Production code must inject
        // a stronger ID generator and should not claim cryptographic randomness here.
        for (let index = 0; index < bytes; index++) {
            values.push(Math.floor(Math.random() * 256));
        }
    }

    let result = "";
    for (const value of values) {
        result += value.toString(16).length === 1 ? `0${value.toString(16)}` : value.toString(16);
    }
    return result;
}

class LocalContextManager implements ContextManager {
    private activeContext = ROOT_CONTEXT;

    public active(): Context {
        return this.activeContext;
    }

    public with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
        activeContext: Context,
        callback: F,
        thisArg?: ThisParameterType<F>,
        ...args: A
    ): ReturnType<F> {
        const previousContext = this.activeContext;
        this.activeContext = activeContext;
        try {
            return callback.call(thisArg, ...args);
        } finally {
            this.activeContext = previousContext;
        }
    }

    public bind<T>(_activeContext: Context, target: T): T {
        return target;
    }

    public enable(): this {
        return this;
    }

    public disable(): this {
        this.activeContext = ROOT_CONTEXT;
        return this;
    }
}

class InstanceSpan implements Span {
    private readonly attributes: Attributes;
    private readonly contextValue: SpanContext;
    private ended = false;

    public constructor(
        private readonly owner: TelemetryInstance,
        private name: string,
        private readonly parentSpanId?: string,
        attributes: Attributes = {}
    ) {
        this.attributes = { ...attributes };
        this.contextValue = {
            traceId: randomHex(16),
            spanId: randomHex(8),
            traceFlags: TraceFlags.SAMPLED
        };
    }

    public spanContext(): SpanContext {
        return this.contextValue;
    }

    public setAttribute(key: string, value: Attributes[string]): this {
        if (value !== undefined) {
            this.attributes[key] = value;
        }
        return this;
    }

    public setAttributes(attributes: Attributes): this {
        Object.assign(this.attributes, attributes);
        return this;
    }

    public addEvent(_name: string, _attributesOrStartTime?: Attributes | TimeInput, _startTime?: TimeInput): this {
        return this;
    }

    public addLink(_link: Link): this {
        return this;
    }

    public addLinks(_links: Link[]): this {
        return this;
    }

    public setStatus(_status: SpanStatus): this {
        return this;
    }

    public updateName(name: string): this {
        this.name = name;
        return this;
    }

    public end(_endTime?: TimeInput): void {
        if (this.ended) {
            return;
        }

        this.ended = true;
        this.owner.spans.push({
            name: this.name,
            traceId: this.contextValue.traceId,
            spanId: this.contextValue.spanId,
            parentSpanId: this.parentSpanId,
            attributes: { ...this.attributes }
        });
    }

    public isRecording(): boolean {
        return !this.ended;
    }

    public recordException(_exception: Exception, _time?: TimeInput): void {
    }
}

class RoutingTracer implements Tracer {
    public constructor(private readonly instance?: TelemetryInstance) {
    }

    public startSpan(name: string, options: SpanOptions = {}, spanContext: Context = context.active()): Span {
        if (!this.instance) {
            return trace.wrapSpanContext({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: TraceFlags.NONE });
        }

        const parent = trace.getSpanContext(spanContext);
        return this.createSpan(this.instance, {
            name,
            parent,
            attributes: options.attributes
        });
    }

    public startActiveSpan<F extends (span: Span) => unknown>(name: string, callback: F): ReturnType<F>;
    public startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, callback: F): ReturnType<F>;
    public startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, spanContext: Context, callback: F): ReturnType<F>;
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

    private createSpan(instance: TelemetryInstance, start: SpanStart): Span {
        const span = new InstanceSpan(instance, start.name, start.parent?.spanId, start.attributes);
        if (start.parent) {
            (span.spanContext() as { traceId: string }).traceId = start.parent.traceId;
        }
        return span;
    }
}

class RoutingTracerProvider implements TracerProvider {
    public constructor(private readonly instances: Map<string, TelemetryInstance>) {
    }

    public getTracer(_name: string, _version?: string, _options?: TracerOptions): Tracer {
        const instanceId = context.active().getValue(INSTANCE_KEY);
        const instance = typeof instanceId === "string" ? this.instances.get(instanceId) : undefined;
        return new RoutingTracer(instance);
    }
}

export function installMultiInstanceBridge(): MultiInstanceBridge {
    const instances = new Map<string, TelemetryInstance>();
    const instrumentations: InstanceInstrumentation[] = [];
    const contextManager = new LocalContextManager().enable();
    const runWithInstance = <T>(instance: TelemetryInstance, callback: () => T): T => {
        if (instances.get(instance.id) !== instance) {
            throw new Error(`Telemetry instance '${instance.id}' is not registered`);
        }
        return context.with(context.active().setValue(INSTANCE_KEY, instance.id), callback);
    };

    if (!context.setGlobalContextManager(contextManager)) {
        throw new Error("An OpenTelemetry ContextManager is already registered");
    }
    if (!trace.setGlobalTracerProvider(new RoutingTracerProvider(instances))) {
        context.disable();
        throw new Error("An OpenTelemetry TracerProvider is already registered");
    }

    return {
        createInstance(id: string): TelemetryInstance {
            if (instances.has(id)) {
                throw new Error(`Telemetry instance '${id}' already exists`);
            }

            const instance = { id, spans: [] };
            instances.set(id, instance);
            return instance;
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
                instrumentation.enable();
                instrumentations.push(instrumentation);
                return instrumentation;
            });
        },
        shutdown(): void {
            for (const instrumentation of instrumentations.splice(0)) {
                instrumentation.disable();
            }
            trace.disable();
            context.disable();
            instances.clear();
        }
    };
}
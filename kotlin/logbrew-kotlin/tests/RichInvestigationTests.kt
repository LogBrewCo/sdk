import co.logbrew.sdk.ActionAttributes
import co.logbrew.sdk.AndroidContext
import co.logbrew.sdk.EnvironmentAttributes
import co.logbrew.sdk.IssueAttributes
import co.logbrew.sdk.IssueBreadcrumb
import co.logbrew.sdk.IssueBreadcrumbLevel
import co.logbrew.sdk.IssueException
import co.logbrew.sdk.IssueExceptionChain
import co.logbrew.sdk.IssueExceptionChainEntry
import co.logbrew.sdk.IssueExceptionMechanism
import co.logbrew.sdk.IssueExceptionMessageState
import co.logbrew.sdk.IssueExceptionRelationship
import co.logbrew.sdk.IssueExceptionStackFramesState
import co.logbrew.sdk.IssueStackFrame
import co.logbrew.sdk.LogAttributes
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewCoroutines
import co.logbrew.sdk.LogBrewTelemetry
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.MetricAttributes
import co.logbrew.sdk.ReleaseAttributes
import co.logbrew.sdk.SdkException
import co.logbrew.sdk.SpanAttributes
import co.logbrew.sdk.SpanLinkSummary
import co.logbrew.sdk.TelemetryApplication
import co.logbrew.sdk.TelemetryContext
import co.logbrew.sdk.TelemetryDeployment
import co.logbrew.sdk.TelemetryDevice
import co.logbrew.sdk.TelemetryNamedVersion
import co.logbrew.sdk.TelemetryOperatingSystem
import co.logbrew.sdk.TelemetryResource
import co.logbrew.sdk.TelemetrySessionContext
import co.logbrew.sdk.TelemetrySubjectContext
import co.logbrew.sdk.TelemetrySubjectKind
import co.logbrew.sdk.TelemetryTraceContext

object RichInvestigationTests {
    private const val TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
    private const val SPAN_ID = "00f067aa0ba902b7"
    private const val OVERRIDE_TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private const val OVERRIDE_SPAN_ID = "bbbbbbbbbbbbbbbb"

    fun runAll() {
        run("shared_context_is_available_on_every_signal", ::sharedContextIsAvailableOnEverySignal)
        run("context_layers_merge_deterministically", ::contextLayersMergeDeterministically)
        run("throwable_capture_is_structured_and_private_by_default", ::throwableCaptureIsStructuredAndPrivateByDefault)
        run("exception_chains_preserve_causes_suppressed_and_states", ::exceptionChainsPreserveCausesSuppressedAndStates)
        run("client_breadcrumbs_are_bounded_and_clearable", ::clientBreadcrumbsAreBoundedAndClearable)
        run("span_links_are_bounded_validated_and_serialized", ::spanLinksAreBoundedValidatedAndSerialized)
        run("android_context_promotes_investigation_fields", ::androidContextPromotesInvestigationFields)
        run("telemetry_context_scopes_nest_and_bridge_optionally", ::telemetryContextScopesNestAndBridgeOptionally)
        run("automatic_context_is_bounded_and_optional", ::automaticContextIsBoundedAndOptional)
    }

    private fun run(
        name: String,
        test: () -> Unit,
    ) {
        try {
            test()
        } catch (error: Throwable) {
            throw IllegalStateException("$name failed", error)
        }
    }

    private fun sharedContextIsAvailableOnEverySignal() {
        val client = client(includeAutomaticContext = false)
        val context =
            TelemetryContext(
                resource = TelemetryResource(service = TelemetryNamedVersion("checkout", "1.2.3")),
                tags = mapOf("region" to "eu"),
            )
        client.release("release", "2026-08-06T00:00:00Z", ReleaseAttributes.create("1.2.3").withContext(context))
        client.environment(
            "environment",
            "2026-08-06T00:00:01Z",
            EnvironmentAttributes.create("production").withContext(context),
        )
        client.issue("issue", "2026-08-06T00:00:02Z", IssueAttributes.create("Failure", "error").withContext(context))
        client.log("log", "2026-08-06T00:00:03Z", LogAttributes.create("failed", "error").withContext(context))
        client.span(
            "span",
            "2026-08-06T00:00:04Z",
            SpanAttributes
                .create("checkout", TRACE_ID, SPAN_ID, "error")
                .withContext(
                    context.merging(
                        TelemetryContext(
                            trace = TelemetryTraceContext(OVERRIDE_TRACE_ID, OVERRIDE_SPAN_ID),
                        ),
                    ),
                ),
        )
        client.metric(
            "metric",
            "2026-08-06T00:00:05Z",
            MetricAttributes.create("checkout.failures", "counter", 1.0, "1", "delta").withContext(context),
        )
        client.action("action", "2026-08-06T00:00:06Z", ActionAttributes.create("checkout", "failure").withContext(context))

        val body = client.previewJson()
        check(Regex("\\\"context\\\"").findAll(body).count() == 7)
        check(Regex("\\\"schemaVersion\\\": 1").findAll(body).count() == 7)
        check("\"service\"" in body)
        check("\"region\": \"eu\"" in body)
        val spanPayload = body.substringAfter("\"id\": \"span\"").substringBefore("\"id\": \"metric\"")
        check("\"trace\"" in spanPayload)
        check(Regex("\\\"traceId\\\": \\\"$TRACE_ID\\\"").findAll(spanPayload).count() == 2)
        check(OVERRIDE_TRACE_ID !in spanPayload)
    }

    private fun contextLayersMergeDeterministically() {
        val clientContext =
            TelemetryContext(
                resource =
                    TelemetryResource(
                        service = TelemetryNamedVersion("checkout", "1.0.0"),
                        deployment = TelemetryDeployment(environment = "staging"),
                    ),
                tags = mapOf("owner" to "payments", "layer" to "client"),
            )
        val client = client(context = clientContext, includeAutomaticContext = false)
        val taskContext =
            TelemetryContext(
                session = TelemetrySessionContext("session-safe"),
                tags = mapOf("layer" to "task"),
            )
        val eventContext =
            TelemetryContext(
                resource = TelemetryResource(deployment = TelemetryDeployment(release = "2026.08.06")),
                trace = TelemetryTraceContext(OVERRIDE_TRACE_ID, OVERRIDE_SPAN_ID, sampled = false),
                subject = TelemetrySubjectContext("opaque-user-7", TelemetrySubjectKind.USER),
                tags = mapOf("layer" to "event"),
            )
        val trace = LogBrewTrace.fromTraceparent("00-$TRACE_ID-$SPAN_ID-01") ?: error("valid traceparent")

        LogBrewTelemetry.withContext(taskContext) {
            LogBrewTrace.withTrace(trace) {
                client.log(
                    "merged",
                    "2026-08-06T00:01:00Z",
                    LogAttributes.create("checkout failed", "error").withContext(eventContext),
                )
            }
        }

        val body = client.previewJson()
        check("\"name\": \"checkout\"" in body)
        check("\"version\": \"1.0.0\"" in body)
        check("\"environment\": \"staging\"" in body)
        check("\"release\": \"2026.08.06\"" in body)
        check("\"id\": \"session-safe\"" in body)
        check("\"id\": \"opaque-user-7\"" in body)
        check("\"kind\": \"user\"" in body)
        check("\"traceId\": \"$OVERRIDE_TRACE_ID\"" in body)
        check("\"spanId\": \"$OVERRIDE_SPAN_ID\"" in body)
        check("\"traceFlags\": \"00\"" in body)
        check("\"traceSampled\": false" in body)
        check(TRACE_ID !in body)
        check("\"owner\": \"payments\"" in body)
        check("\"layer\": \"event\"" in body)
        check("\"layer\": \"client\"" !in body)
        check("\"layer\": \"task\"" !in body)
        check("\"runtime\"" !in body)
    }

    private fun throwableCaptureIsStructuredAndPrivateByDefault() {
        val restrictedText = "card=4111111111111111"
        val error = IllegalStateException(restrictedText)
        error.stackTrace =
            arrayOf(
                StackTraceElement("checkout.PaymentService", "charge", "/workspace/app/PaymentService.kt?query=redacted", 73),
            )
        val client = client(includeAutomaticContext = false)
        client.issue(
            "structured",
            "2026-08-06T00:02:00Z",
            IssueAttributes.fromThrowable(error, mechanismType = "kotlin.exception", handled = true),
        )

        val body = client.previewJson()
        check("\"exception\"" in body)
        check("\"type\": \"IllegalStateException\"" in body)
        check("\"mechanism\"" in body)
        check("\"type\": \"kotlin.exception\"" in body)
        check("\"handled\": true" in body)
        check("\"stackFrames\"" in body)
        check("\"filename\": \"PaymentService.kt\"" in body)
        check("\"function\": \"charge\"" in body)
        check("\"module\": \"checkout.PaymentService\"" in body)
        check(restrictedText !in body)
        check("/workspace/app" !in body)
        check("query=redacted" !in body)

        val androidClient = client(includeAutomaticContext = false)
        LogBrewAndroid.captureThrowable(
            client = androidClient,
            id = "android-structured",
            timestamp = "2026-08-06T00:02:01Z",
            throwable = error,
        )
        val androidBody = androidClient.previewJson()
        check("\"type\": \"android.exception\"" in androidBody)
        check(restrictedText !in androidBody)
        check("throwableStackTrace" !in androidBody)

        val unknownFrameError = IllegalStateException("restricted-description")
        unknownFrameError.stackTrace = arrayOf(StackTraceElement("checkout.NativeBridge", "invoke", null, -2))
        val unknownFrameClient = client(includeAutomaticContext = false)
        unknownFrameClient.issue(
            "unknown-frame",
            "2026-08-06T00:02:02Z",
            IssueAttributes.fromThrowable(unknownFrameError),
        )
        val unknownFrameBody = unknownFrameClient.previewJson()
        check("\"exception\"" in unknownFrameBody)
        check("\"stackFrames\"" !in unknownFrameBody)
        check("Thread.kt" !in unknownFrameBody)
        check("restricted-description" !in unknownFrameBody)
    }

    private fun exceptionChainsPreserveCausesSuppressedAndStates() {
        val cause = IllegalArgumentException("private cause message")
        cause.stackTrace =
            arrayOf(
                StackTraceElement("checkout.PaymentClient", "charge", "PaymentClient.kt", 18),
            )
        val suppressed = IllegalStateException("private suppressed message")
        suppressed.stackTrace =
            arrayOf(
                StackTraceElement("checkout.AuditWriter", "write", "AuditWriter.kt", 29),
            )
        val error = IllegalStateException("reported-message-canary", cause)
        error.addSuppressed(suppressed)
        error.stackTrace =
            arrayOf(
                StackTraceElement("checkout.CheckoutHandler", "submit", "CheckoutHandler.kt", 42),
            )

        val client = client(includeAutomaticContext = false)
        client.issue(
            "exception-chain",
            "2026-08-06T00:02:03Z",
            IssueAttributes.fromThrowable(error, mechanismType = "kotlin.exception", handled = false),
        )
        val body = client.previewJson()
        check("\"exceptionChain\"" in body)
        check("\"relationship\": \"reported\"" in body)
        check("\"relationship\": \"cause\"" in body)
        check("\"relationship\": \"suppressed\"" in body)
        check("\"parentId\": 0" in body)
        check("\"messageState\": \"redacted\"" in body)
        check("\"stackFramesState\": \"captured\"" in body)
        check("\"type\": \"kotlin.cause\"" in body)
        check("\"type\": \"kotlin.suppressed\"" in body)
        check("PaymentClient.kt" in body)
        check("AuditWriter.kt" in body)
        check("reported-message-canary" !in body)
        check("private cause message" !in body)
        check("private suppressed message" !in body)

        var deep: Throwable = IllegalStateException("private depth 9")
        for (depth in 8 downTo 0) {
            deep = IllegalStateException("private depth $depth", deep)
        }
        val deepClient = client(includeAutomaticContext = false)
        deepClient.issue(
            "deep-exception-chain",
            "2026-08-06T00:02:04Z",
            IssueAttributes.fromThrowable(deep),
        )
        val deepBody = deepClient.previewJson()
        check(Regex("\\\"relationship\\\": \\\"reported\\\"").findAll(deepBody).count() == 1)
        check(Regex("\\\"relationship\\\": \\\"cause\\\"").findAll(deepBody).count() == 7)
        check("\"truncated\": true" in deepBody)
        check("private depth" !in deepBody)

        val mechanism = IssueExceptionMechanism("kotlin.manual", handled = true)
        val rootFrame =
            IssueStackFrame(
                filename = "Checkout.kt",
                line = 42,
                column = 3,
                function = "submit",
                module = "checkout.Checkout",
            )
        val manualChain =
            IssueExceptionChain(
                entries =
                    listOf(
                        IssueExceptionChainEntry(
                            id = 0,
                            relationship = IssueExceptionRelationship.REPORTED,
                            type = "CheckoutFailure",
                            message = "approved summary",
                            messageState = IssueExceptionMessageState.TRUNCATED,
                            mechanism = mechanism,
                            stackFrames = listOf(rootFrame),
                            stackFramesState = IssueExceptionStackFramesState.CAPTURED,
                        ),
                        IssueExceptionChainEntry(
                            id = 1,
                            parentId = 0,
                            relationship = IssueExceptionRelationship.CONTEXT,
                            type = "RequestContextFailure",
                            messageState = IssueExceptionMessageState.REDACTED,
                            mechanism = IssueExceptionMechanism("kotlin.context", handled = true),
                        ),
                    ),
                truncated = true,
            )
        val manualClient = client(includeAutomaticContext = false)
        manualClient.issue(
            "manual-exception-chain",
            "2026-08-06T00:02:05Z",
            IssueAttributes
                .create("Checkout failed", "error")
                .withException(IssueException("CheckoutFailure", mechanism))
                .withStackFrame(rootFrame)
                .withExceptionChain(manualChain),
        )
        val manualBody = manualClient.previewJson()
        check("\"message\": \"approved summary\"" in manualBody)
        check("\"messageState\": \"truncated\"" in manualBody)
        check("\"relationship\": \"context\"" in manualBody)
        check("\"stackFramesState\": \"not_captured\"" in manualBody)

        expectValidation {
            client(includeAutomaticContext = false).issue(
                "bad-exception-chain",
                "2026-08-06T00:02:06Z",
                IssueAttributes
                    .create("Bad chain", "error")
                    .withException(IssueException("CheckoutFailure"))
                    .withExceptionChain(
                        IssueExceptionChain(
                            listOf(
                                IssueExceptionChainEntry(
                                    id = 0,
                                    relationship = IssueExceptionRelationship.CAUSE,
                                    type = "CheckoutFailure",
                                ),
                            ),
                        ),
                    ),
            )
        }
    }

    private fun clientBreadcrumbsAreBoundedAndClearable() {
        val client = client(includeAutomaticContext = false)
        repeat(66) { index ->
            client.addBreadcrumb(
                IssueBreadcrumb(
                    timestamp = "2026-08-06T00:03:${index.coerceAtMost(59).toString().padStart(2, '0')}Z",
                    category = "navigation",
                    level = IssueBreadcrumbLevel.INFO,
                    message = "step-$index",
                    data = mapOf("sequence" to index),
                ),
            )
        }
        client.issue("with-crumbs", "2026-08-06T00:04:00Z", IssueAttributes.create("Failure", "error"))
        val body = client.previewJson()
        check("\"breadcrumbsTruncated\": true" in body)
        check("\"message\": \"step-0\"" !in body)
        check("\"message\": \"step-1\"" !in body)
        check("\"message\": \"step-2\"" in body)
        check("\"message\": \"step-65\"" in body)

        expectValidation {
            client.issue(
                "too-many-explicit-crumbs",
                "2026-08-06T00:04:00Z",
                IssueAttributes(
                    title = "Failure",
                    level = "error",
                    breadcrumbs =
                        List(65) { index ->
                            IssueBreadcrumb(
                                timestamp = "2026-08-06T00:03:00Z",
                                category = "step",
                                message = "explicit-$index",
                            )
                        },
                ),
            )
        }

        client.clearBreadcrumbs()
        client.issue("without-crumbs", "2026-08-06T00:04:01Z", IssueAttributes.create("Another failure", "error"))
        val clearedEvent = client.previewJson().substringAfter("\"id\": \"without-crumbs\"")
        check("\"breadcrumbs\"" !in clearedEvent)
    }

    private fun spanLinksAreBoundedValidatedAndSerialized() {
        val client = client(includeAutomaticContext = false)
        val link =
            SpanLinkSummary(
                traceId = TRACE_ID.uppercase(),
                spanId = SPAN_ID.uppercase(),
                sampled = true,
                metadata = mapOf("relation" to "batch.parent"),
            )
        client.span(
            "linked",
            "2026-08-06T00:05:00Z",
            SpanAttributes.create("batch.consume", TRACE_ID, SPAN_ID, "ok").withLink(link),
        )
        val body = client.previewJson()
        check("\"links\"" in body)
        check("\"traceId\": \"$TRACE_ID\"" in body)
        check("\"spanId\": \"$SPAN_ID\"" in body)
        check("\"relation\": \"batch.parent\"" in body)

        expectValidation {
            client(includeAutomaticContext = false).span(
                "too-many-links",
                "2026-08-06T00:05:01Z",
                SpanAttributes
                    .create("batch.consume", TRACE_ID, SPAN_ID, "ok")
                    .withLinks(List(9) { link }),
            )
        }
        expectValidation {
            client(includeAutomaticContext = false).span(
                "invalid-link",
                "2026-08-06T00:05:02Z",
                SpanAttributes
                    .create("batch.consume", TRACE_ID, SPAN_ID, "ok")
                    .withLink(SpanLinkSummary("0".repeat(32), SPAN_ID)),
            )
        }
        expectValidation {
            client(includeAutomaticContext = false).log(
                "non-finite",
                "2026-08-06T00:05:03Z",
                LogAttributes.create("bad metadata", "error").withMetadata(mapOf("ratio" to Double.NaN)),
            )
        }
        expectValidation {
            client(includeAutomaticContext = false).log(
                "empty-key",
                "2026-08-06T00:05:04Z",
                LogAttributes.create("bad metadata", "error").withMetadata(mapOf("" to "value")),
            )
        }
        expectValidation {
            client(includeAutomaticContext = false).issue(
                "bad-debug-id",
                "2026-08-06T00:05:05Z",
                IssueAttributes
                    .create("bad frame", "error")
                    .withStackFrame(IssueStackFrame("Checkout.kt", 1, 1, debugId = "1-1-1-1-1")),
            )
        }
    }

    private fun androidContextPromotesInvestigationFields() {
        val client =
            LogBrewAndroid.createClient(
                apiKey = "LOGBREW_API_KEY",
                appName = "checkout-android",
                includeAutomaticContext = false,
            )
        val context =
            AndroidContext
                .create()
                .withDeviceModel("Pixel 10")
                .withOsVersion("16")
                .withSessionId("session-android")
                .withApplication(version = "2.4.0", build = "20400")
        LogBrewAndroid.captureScreenView(client, "screen", "2026-08-06T00:06:00Z", "Checkout", context)

        val body = client.previewJson()
        check("\"framework\"" in body)
        check("\"name\": \"android\"" in body)
        check("\"application\"" in body)
        check("\"name\": \"checkout-android\"" in body)
        check("\"version\": \"2.4.0\"" in body)
        check("\"build\": \"20400\"" in body)
        check("\"operatingSystem\"" in body)
        check("\"name\": \"Android\"" in body)
        check("\"device\"" in body)
        check("\"model\": \"Pixel 10\"" in body)
        check("\"session\"" in body)
        check("\"id\": \"session-android\"" in body)
    }

    private fun telemetryContextScopesNestAndBridgeOptionally() {
        val outer = TelemetryContext(tags = mapOf("scope" to "outer"))
        val inner =
            TelemetryContext(
                deviceContext(),
                tags = mapOf("scope" to "inner"),
            )
        check(LogBrewTelemetry.currentContext() == null)
        LogBrewTelemetry.withContext(outer) {
            check(LogBrewTelemetry.currentContext()?.tags?.get("scope") == "outer")
            LogBrewTelemetry.withContext(inner) {
                check(LogBrewTelemetry.currentContext()?.tags?.get("scope") == "inner")
                check(
                    LogBrewTelemetry
                        .currentContext()
                        ?.resource
                        ?.device
                        ?.model == "Pixel",
                )
            }
            check(LogBrewTelemetry.currentContext()?.tags?.get("scope") == "outer")
        }
        check(LogBrewTelemetry.currentContext() == null)
        check(LogBrewCoroutines.telemetryContextElement(outer) == null)
        check(LogBrewCoroutines.currentTelemetryContextElement() == null)
    }

    private fun automaticContextIsBoundedAndOptional() {
        val automatic = client()
        automatic.log("automatic", "2026-08-06T00:07:00Z", LogAttributes.create("automatic context", "info"))
        val body = automatic.previewJson()
        check("\"name\": \"kotlin/jvm\"" in body)
        check("kotlin ${KotlinVersion.CURRENT}" in body)
        check("jvm ${System.getProperty("java.version")}" in body)
        check("\"operatingSystem\"" in body)
        check("\"architecture\": \"${System.getProperty("os.arch")}\"" in body)

        val disabled = client(includeAutomaticContext = false)
        disabled.log("disabled", "2026-08-06T00:07:01Z", LogAttributes.create("no defaults", "info"))
        check("\"context\"" !in disabled.previewJson())
    }

    private fun deviceContext(): TelemetryResource =
        TelemetryResource(
            device = TelemetryDevice(family = "phone", model = "Pixel", architecture = "arm64"),
            operatingSystem = TelemetryOperatingSystem("Android", "16"),
            application = TelemetryApplication("checkout"),
        )

    private fun client(
        context: TelemetryContext? = null,
        includeAutomaticContext: Boolean = true,
    ): LogBrewClient =
        LogBrewClient.create(
            apiKey = "LOGBREW_API_KEY",
            sdkName = "logbrew-kotlin-rich-tests",
            sdkVersion = "0.2.0",
            context = context,
            includeAutomaticContext = includeAutomaticContext,
        )

    private fun expectValidation(block: () -> Unit) {
        try {
            block()
        } catch (error: SdkException) {
            check(error.code == "validation_error")
            return
        }
        error("expected validation_error")
    }
}

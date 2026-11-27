import co.logbrew.sdk.LogAttributes
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.SdkException
import co.logbrew.sdk.TransportResponse
import java.io.File

fun clientWithoutKeySendsWithServerApiKeyVariable() = runServerApiKeyCase("env_key", "env-server-key")

fun explicitKeyWinsOverServerApiKeyVariable() = runServerApiKeyCase("explicit_key", "env-server-key")

fun missingKeyNamesTheServerApiKeyVariable() = runServerApiKeyCase("missing_key", " ")

/** Starts this test program again in a child JVM that owns its environment, with the case name as its argument. */
private fun runServerApiKeyCase(
    name: String,
    serverApiKey: String,
) {
    val java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java"
    val builder =
        ProcessBuilder(java, "-cp", System.getProperty("java.class.path"), "LogBrewKotlinTestKt", name)
            .redirectErrorStream(true)
    builder.environment()["LOGBREW_SERVER_API_KEY"] = serverApiKey
    val process = builder.start()
    val output = process.inputStream.readBytes().toString(Charsets.UTF_8)
    check(process.waitFor() == 0) { "$name failed: $output" }
}

fun runServerApiKeyChild(name: String) {
    when (name) {
        "env_key" -> {
            check(sentApiKeys(null) == listOf("env-server-key"))
        }

        "explicit_key" -> {
            check(sentApiKeys("explicit-key") == listOf("explicit-key"))
        }

        "missing_key" -> {
            val error =
                runCatching { LogBrewClient.create(sdkName = "logbrew-kotlin-test", sdkVersion = "1.0.0") }
                    .exceptionOrNull()
            check(error is SdkException && error.code == "configuration_error" && "LOGBREW_SERVER_API_KEY" in error.detailMessage) {
                "unexpected error: $error"
            }
        }

        else -> {
            error("unknown case $name")
        }
    }
}

private fun sentApiKeys(explicitKey: String?): List<String> {
    val sentKeys = mutableListOf<String>()
    val client = LogBrewClient.create(apiKey = explicitKey, sdkName = "logbrew-kotlin-test", sdkVersion = "1.0.0")
    client.log("evt_server_key_001", "2026-11-27T10:00:00Z", LogAttributes(message = "first event", level = "info"))
    client.flush { apiKey, _ ->
        sentKeys += apiKey
        TransportResponse(statusCode = 202, attempts = 1)
    }
    return sentKeys
}

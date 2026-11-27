package co.logbrew.sdk;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Checks server API key resolution. Each case runs in a child JVM that owns its environment.
 */
public final class ServerApiKeyTest {
    private ServerApiKeyTest() {
    }

    public static void main(String[] args) throws IOException, InterruptedException {
        if (args.length == 2 && "child".equals(args[0])) {
            runChildCase(args[1]);
            return;
        }
        runCase("env_key", "env-server-key");
        runCase("explicit_key", "env-server-key");
        runCase("missing_key", " ");
        System.out.println("ServerApiKeyTest passed 3 tests");
    }

    private static void runCase(String name, String serverApiKey) throws IOException, InterruptedException {
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        ProcessBuilder builder = new ProcessBuilder(
            java, "-cp", System.getProperty("java.class.path"), ServerApiKeyTest.class.getName(), "child", name
        ).redirectErrorStream(true);
        builder.environment().put("LOGBREW_SERVER_API_KEY", serverApiKey);
        Process process = builder.start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        if (process.waitFor() != 0) {
            throw new AssertionError(name + " failed: " + output);
        }
    }

    private static void runChildCase(String name) {
        switch (name) {
            case "env_key":
                expectSentKeys(null, "env-server-key");
                break;
            case "explicit_key":
                expectSentKeys("explicit-key", "explicit-key");
                break;
            case "missing_key":
                try {
                    LogBrewClient.create(null, "logbrew-java-test", "1.0.0");
                    throw new AssertionError("expected a configuration error");
                } catch (SdkException error) {
                    if (!"configuration_error".equals(error.code())
                        || !error.getMessage().contains("LOGBREW_SERVER_API_KEY")) {
                        throw new AssertionError("unexpected error: " + error.code() + " " + error.getMessage(), error);
                    }
                }
                break;
            default:
                throw new AssertionError("unknown case " + name);
        }
    }

    private static void expectSentKeys(String explicitKey, String expectedKey) {
        List<String> sentKeys = new ArrayList<>();
        LogBrewClient client = LogBrewClient.create(explicitKey, "logbrew-java-test", "1.0.0");
        client.log("evt_server_key_001", "2026-11-27T10:00:00Z", LogAttributes.create("first event", "info"));
        client.flush((apiKey, body) -> {
            sentKeys.add(apiKey);
            return new TransportResponse(202, 1);
        });
        if (!List.of(expectedKey).equals(sentKeys)) {
            throw new AssertionError("sent keys " + sentKeys + ", want [" + expectedKey + "]");
        }
    }
}

#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/java/logbrew-java"
tmp_dir="$(mktemp -d)"

# shellcheck source=scripts/java_logback_deps.sh
source "$repo_root/scripts/java_logback_deps.sh"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

package_version="$(python3 - "$package_dir/pom.xml" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
namespace = {"m": "http://maven.apache.org/POM/4.0.0"}
print(root.findtext("m:version", namespaces=namespace))
PY
)"

main_sources="$tmp_dir/main-sources.txt"
find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"
mkdir -p "$tmp_dir/classes" "$tmp_dir/app/classes" "$tmp_dir/app/lib" \
  "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk"

java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"
java_opentelemetry_classpath="$(fetch_java_opentelemetry_deps "$tmp_dir/java-opentelemetry-deps")"
java_servlet_classpath="$(fetch_java_servlet_deps "$tmp_dir/java-servlet-deps")"
java_spring_boot_classpath="$(fetch_java_spring_boot_deps "$tmp_dir/java-spring-boot-deps")"
java_spring_kafka_classpath="$(fetch_java_spring_kafka_deps "$tmp_dir/java-spring-kafka-deps")"
java_spring_web_classpath="$(fetch_java_spring_web_deps "$tmp_dir/java-spring-web-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath:$java_spring_boot_classpath:$java_spring_kafka_classpath:$java_spring_web_classpath"

javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" \
  -d "$tmp_dir/classes" @"$main_sources"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
cp -R "$package_dir/src/main/resources/." "$tmp_dir/jar-stage/"
jar --create --file "$tmp_dir/app/lib/logbrew-sdk-$package_version.jar" -C "$tmp_dir/jar-stage" .

cat > "$tmp_dir/app/SpringHttpInstalledApp.java" <<'JAVA'
import co.logbrew.sdk.HttpTransport;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewSpringHttpTracing;
import co.logbrew.sdk.LogBrewSpringWebClientTracing;
import co.logbrew.sdk.LogBrewTrace;
import co.logbrew.sdk.LogBrewTraceContext;
import co.logbrew.sdk.TransportResponse;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;

public final class SpringHttpInstalledApp {
    public static void main(String[] args) throws Exception {
        AtomicInteger dependencyRequests = new AtomicInteger();
        AtomicInteger intakeRequests = new AtomicInteger();
        AtomicReference<String> intakeBody = new AtomicReference<>();
        List<String> propagated = new ArrayList<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        server.setExecutor(executor);
        server.createContext("/dependency", exchange -> {
            dependencyRequests.incrementAndGet();
            propagated.add(exchange.getRequestHeaders().getFirst("traceparent"));
            reply(exchange, 202);
        });
        server.createContext("/v1/events", exchange -> {
            intakeRequests.incrementAndGet();
            intakeBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            reply(exchange, 202);
        });
        server.start();

        try {
            int port = server.getAddress().getPort();
            LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "spring-http-installed", "0.1.0");
            LogBrewTraceContext parent = LogBrewTraceContext.create(
                "11111111111111111111111111111111",
                "2222222222222222"
            );
            RestTemplate restTemplate = new RestTemplate();
            restTemplate.getInterceptors().add(LogBrewSpringHttpTracing.restTemplateInterceptor(client));

            LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
            try {
                ResponseEntity<String> response = restTemplate.getForEntity(
                    URI.create("http://127.0.0.1:" + port + "/dependency/fixture-order?" + sampleQuery()),
                    String.class
                );
                require(response.getStatusCode().value() == 202, "blocking response");

                ClientRequest request = ClientRequest.create(
                    HttpMethod.POST,
                    URI.create("https://reactive.example/fixture-order?" + sampleQuery())
                ).header("authorization", "sensitive-value").build();
                ClientResponse reactive = LogBrewSpringWebClientTracing.filter(client)
                    .filter(request, actualRequest -> {
                        propagated.add(actualRequest.headers().getFirst("traceparent"));
                        return reactor.core.publisher.Mono.just(
                            ClientResponse.create(HttpStatus.NO_CONTENT).build()
                        );
                    })
                    .block();
                require(reactive.statusCode().value() == 204, "reactive response");
                require(LogBrewTrace.current().orElseThrow() == parent, "parent trace restored");
            } finally {
                scope.close();
            }

            require(propagated.size() == 2, "two propagated requests");
            require(!propagated.get(0).equals(propagated.get(1)), "independent child contexts");
            for (String traceparent : propagated) {
                require(traceparent.startsWith("00-11111111111111111111111111111111-"), "trace id propagated");
            }
            require(client.pendingEvents() == 2, "two dependency spans queued");

            TransportResponse delivery = client.shutdown(
                HttpTransport.builder()
                    .endpoint(URI.create("http://127.0.0.1:" + port + "/v1/events"))
                    .build()
            );
            require(delivery.statusCode() == 202, "intake accepted payload");
            require(dependencyRequests.get() == 1, "one real dependency request");
            require(intakeRequests.get() == 1, "one intake request");

            String payload = intakeBody.get();
            requireContains(payload, "\"source\": \"spring.resttemplate\"");
            requireContains(payload, "\"source\": \"spring.webclient\"");
            requireContains(payload, "\"host\": \"127.0.0.1\"");
            requireContains(payload, "\"host\": \"reactive.example\"");
            requireContains(payload, "\"statusCode\": 202");
            requireContains(payload, "\"statusCode\": 204");
            requireContains(payload, "\"traceId\": \"11111111111111111111111111111111\"");
            requireContains(payload, "\"parentSpanId\": \"2222222222222222\"");
            requireNotContains(payload, "fixture-order");
            requireNotContains(payload, sampleQuery());
            requireNotContains(payload, "authorization");
            requireNotContains(payload, "sensitive-value");
            System.out.println("{\"dependencyRequests\":1,\"intakeRequests\":1,\"spans\":2}");
        } finally {
            server.stop(0);
            executor.shutdownNow();
        }
    }

    private static void reply(HttpExchange exchange, int status) throws IOException {
        exchange.sendResponseHeaders(status, -1);
        exchange.close();
    }

    private static String sampleQuery() {
        return "to" + "ken=sample";
    }

    private static void requireContains(String value, String expected) {
        require(value != null && value.contains(expected), "missing expected payload field");
    }

    private static void requireNotContains(String value, String unexpected) {
        require(value != null && !value.contains(unexpected), "unexpected value entered payload");
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
JAVA

javac -Xlint:all -Werror --release 17 \
  -cp "$tmp_dir/app/lib/logbrew-sdk-$package_version.jar:$java_optional_classpath" \
  -d "$tmp_dir/app/classes" "$tmp_dir/app/SpringHttpInstalledApp.java"

app_output="$(java -cp "$tmp_dir/app/classes:$tmp_dir/app/lib/logbrew-sdk-$package_version.jar:$java_optional_classpath" \
  SpringHttpInstalledApp)"
test "$app_output" = '{"dependencyRequests":1,"intakeRequests":1,"spans":2}'
artifact_sha256="$(shasum -a 256 "$tmp_dir/app/lib/logbrew-sdk-$package_version.jar" | awk '{print $1}')"
printf 'java Spring HTTP installed-artifact smoke ok (version=%s sha256=%s)\n' \
  "$package_version" "$artifact_sha256"

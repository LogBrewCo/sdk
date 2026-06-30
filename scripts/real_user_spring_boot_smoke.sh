#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/java/logbrew-java"
tmp_dir="$(mktemp -d)"
spring_boot_version="${LOGBREW_SPRING_BOOT_VERSION:-4.0.6}"
failure_diagnostics_printed=false

# shellcheck source=scripts/java_logback_deps.sh
source "$repo_root/scripts/java_logback_deps.sh"

print_failure_diagnostics() {
  local status=$1
  if [ "$status" -eq 0 ]; then
    return
  fi

  echo "spring boot real-user smoke failed with exit $status" >&2
  failure_diagnostics_printed=true
  for file in \
    "$tmp_dir/spring-boot.stderr.json" \
    "$tmp_dir/spring-boot.stdout.json" \
    "$tmp_dir/gradle-deps.txt"; do
    if [ -s "$file" ]; then
      echo "--- ${file#"$tmp_dir/"} ---" >&2
      tail -n 80 "$file" >&2
    fi
  done
}

cleanup() {
  local status=$?
  if [ "$failure_diagnostics_printed" != "true" ]; then
    print_failure_diagnostics "$status"
  fi
  rm -rf "$tmp_dir"
  exit "$status"
}

trap cleanup EXIT

if ! command -v gradle >/dev/null 2>&1; then
  echo "gradle is required for the Spring Boot real-user smoke" >&2
  exit 1
fi

main_sources="$tmp_dir/main-sources.txt"
find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"

mkdir -p "$tmp_dir/classes" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk"
java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"
java_opentelemetry_classpath="$(fetch_java_opentelemetry_deps "$tmp_dir/java-opentelemetry-deps")"
java_servlet_classpath="$(fetch_java_servlet_deps "$tmp_dir/java-servlet-deps")"
java_spring_boot_classpath="$(fetch_java_spring_boot_deps "$tmp_dir/java-spring-boot-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath:$java_spring_boot_classpath"

javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" -d "$tmp_dir/classes" @"$main_sources"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
if [ -d "$package_dir/src/main/resources" ]; then
  cp -R "$package_dir/src/main/resources/." "$tmp_dir/jar-stage/"
fi
jar --create --file "$tmp_dir/logbrew-sdk-0.1.0.jar" -C "$tmp_dir/jar-stage" .

maven_dir="$tmp_dir/maven/co/logbrew/logbrew-sdk/0.1.0"
mkdir -p "$maven_dir"
cp "$tmp_dir/logbrew-sdk-0.1.0.jar" "$maven_dir/logbrew-sdk-0.1.0.jar"
cp "$package_dir/pom.xml" "$maven_dir/logbrew-sdk-0.1.0.pom"

gradle_app="$tmp_dir/spring-boot-app"
gradle_home="$tmp_dir/gradle-home"
mkdir -p "$gradle_app/src/main/java/app" "$gradle_home"
cat > "$gradle_app/settings.gradle" <<'EOF'
rootProject.name = "logbrew-spring-boot-smoke"
EOF
cat > "$gradle_app/build.gradle" <<EOF
plugins {
    id 'application'
}

repositories {
    maven {
        url = uri('$tmp_dir/maven')
    }
    mavenCentral()
}

dependencies {
    implementation 'co.logbrew:logbrew-sdk:0.1.0'
    implementation 'org.springframework.boot:spring-boot-starter:$spring_boot_version'
    implementation 'org.springframework.boot:spring-boot-starter-web:$spring_boot_version'
}

application {
    mainClass = 'app.Main'
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.withType(JavaCompile).configureEach {
    options.release = 17
    options.compilerArgs.addAll(['-Xlint:all', '-Werror'])
}
EOF
cat > "$gradle_app/src/main/java/app/Main.java" <<'JAVA'
package app;

import ch.qos.logback.classic.LoggerContext;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewLogbackAppender;
import co.logbrew.sdk.RecordingTransport;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.sql.DataSource;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootVersion;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
public class Main implements CommandLineRunner {
    private static final String TRACEPARENT =
        "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
    private static final LogBrewClient CLIENT = LogBrewClient.create("LOGBREW_API_KEY", "spring-boot-smoke", "0.1.0");
    private static final RecordingTransport TRANSPORT = RecordingTransport.alwaysAccept();

    private final Environment environment;

    public Main(Environment environment) {
        this.environment = environment;
    }

    public static void main(String[] args) throws Exception {
        SpringApplication app = new SpringApplication(Main.class);
        app.setWebApplicationType(WebApplicationType.SERVLET);
        app.setDefaultProperties(defaultProperties());
        ConfigurableApplicationContext context = app.run(args);
        require(
            context.containsBean("logBrewJdbcDataSourcePostProcessor"),
            "Spring Boot JDBC auto-configuration registers DataSource post-processor"
        );
        require(
            context.getBean(DataSource.class).toString().contains("LogBrewJdbcTracing"),
            "Spring Boot JDBC auto-configuration wraps the DataSource bean"
        );
        context.close();

        String body = TRANSPORT.lastBody().orElseThrow(() -> new AssertionError("expected LogBrew batch"));
        System.out.println(body);
        require(CLIENT.pendingEvents() == 0, "Spring Boot appender stop flush clears queue");
        require(TRANSPORT.sentBodies().size() == 1, "Spring Boot appender sends one batch");
        require(occurrences(body, "\"type\": \"log\"") == 3, "Spring Boot appender captures three logs");
        require(occurrences(body, "\"type\": \"span\"") == 4, "Spring Boot captures request and JDBC spans");
        require(occurrences(body, "\"type\": \"metric\"") == 1, "Spring Boot servlet filter captures one metric");
        require(body.contains("\"logger\": \"app.checkout\""), "captures app logger");
        require(body.contains("\"source\": \"logback\""), "records Logback source");
        require(body.contains("\"source\": \"jakarta-servlet\""), "records servlet source");
        require(body.contains("\"source\": \"jdbc.connection\""), "records JDBC connection source");
        require(body.contains("\"source\": \"jdbc.statement\""), "records JDBC statement source");
        require(body.contains("\"source\": \"jdbc.transaction\""), "records JDBC transaction source");
        require(body.contains("\"springApplicationName\": \"checkout-service\""), "captures Spring application name");
        require(body.contains("\"mdc.traceId\": \"trace_123\""), "captures MDC trace id");
        require(body.contains("\"kv.cartId\": 42"), "captures SLF4J key value pair");
        require(body.contains("\"kv.routeVerified\": true"), "captures request handler log key value pair");
        require(body.contains("\"level\": \"warning\""), "maps warn level");
        require(body.contains("\"level\": \"error\""), "maps error level");
        require(body.contains("\"exceptionType\": \"IllegalStateException\""), "captures exception type");
        require(body.contains("\"name\": \"POST /checkout/{cartId}\""), "uses Spring route template for request span");
        require(body.contains("\"name\": \"jdbc:CONNECT\""), "auto-configured JDBC acquisition span");
        require(body.contains("\"name\": \"jdbc:SELECT\""), "auto-configured JDBC statement span");
        require(body.contains("\"name\": \"jdbc:COMMIT\""), "auto-configured JDBC transaction span");
        require(body.contains("\"name\": \"http.server.duration\""), "captures request duration metric");
        require(body.contains("\"dbSystem\": \"postgresql\""), "records configured JDBC system");
        require(body.contains("\"dbName\": \"orders\""), "records configured JDBC database name");
        require(body.contains("\"routeTemplate\": \"/checkout/{cartId}\""), "records route template metadata");
        require(body.contains("\"routeSource\": \"spring_best_matching_pattern\""), "records Spring route source");
        require(body.contains("\"statusCode\": 202"), "captures HTTP status");
        require(body.contains("\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\""), "continues incoming trace id");
        require(body.contains("\"parentSpanId\": \"00f067aa0ba902b7\""), "links incoming parent span");
        require(!body.contains("checkout/42"), "omits raw high-cardinality request path");
        require(!body.contains("debug=hidden"), "omits query string");
        require(!body.contains("traceparent"), "omits raw propagation header");
        require(!body.contains("synthetic_column"), "omits raw JDBC query column");
        require(!body.contains("synthetic_value"), "omits raw JDBC query literal");
        require(!body.contains("jdbc_user_fixture"), "omits JDBC login argument");
        require(!body.contains("jdbc_pass_fixture"), "omits JDBC second login argument");
        require(!body.contains("checkoutDataSource"), "omits Spring data-source bean name");
        require(!body.contains("logbackStackTrace"), "omits stack text by default");
        System.err.println("{\"ok\":true,\"springBootVersion\":\"" + SpringBootVersion.getVersion() + "\",\"events\":8}");
    }

    @Override
    public void run(String... args) throws Exception {
        ch.qos.logback.classic.Logger logger = logbackLogger("app.checkout");
        ch.qos.logback.classic.Level originalLevel = logger.getLevel();
        boolean originalAdditive = logger.isAdditive();
        LogBrewLogbackAppender appender = new LogBrewLogbackAppender(CLIENT, TRANSPORT, false);
        appender.setName("LOGBREW");
        appender.setEventIdPrefix("spring_boot_logback");
        appender.setMetadata(springMetadata());
        appender.start();
        try {
            logger.setAdditive(false);
            logger.setLevel(ch.qos.logback.classic.Level.TRACE);
            logger.addAppender(appender);
            MDC.put("traceId", "trace_123");
            logger.atWarn().addKeyValue("cartId", Integer.valueOf(42)).log("spring boot checkout");
            logger.error("spring boot checkout failed", new IllegalStateException("database unavailable"));
            exerciseRequest();
        } finally {
            MDC.remove("traceId");
            logger.detachAppender(appender);
            logger.setLevel(originalLevel);
            logger.setAdditive(originalAdditive);
            appender.stop();
        }
    }

    @Bean
    LogBrewClient logBrewClient() {
        return CLIENT;
    }

    @Bean
    DataSource checkoutDataSource() {
        return fakeDataSource();
    }

    private static Map<String, Object> defaultProperties() {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("spring.application.name", "checkout-service");
        values.put("spring.main.banner-mode", "off");
        values.put("logging.level.root", "error");
        values.put("server.address", "127.0.0.1");
        values.put("server.port", "0");
        values.put("server.error.include-message", "always");
        values.put("server.error.include-exception", "true");
        values.put("logbrew.jdbc.trace-connection-acquisition", "true");
        values.put("logbrew.jdbc.trace-transactions", "true");
        values.put("logbrew.jdbc.db-system", "postgresql");
        values.put("logbrew.jdbc.db-name", "orders");
        return values;
    }

    private void exerciseRequest() throws Exception {
        int port = Integer.parseInt(environment.getRequiredProperty("local.server.port"));
        HttpRequest request = HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + port + "/checkout/42?debug=hidden"))
            .header("traceparent", TRACEPARENT)
            .POST(HttpRequest.BodyPublishers.noBody())
            .build();
        HttpResponse<String> response =
            HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
        require(
            response.statusCode() == 202,
            "Spring Boot request returns 202, got " + response.statusCode() + " body=" + response.body()
        );
    }

    private Map<String, Object> springMetadata() {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("springApplicationName", environment.getProperty("spring.application.name", "application"));
        String[] activeProfiles = environment.getActiveProfiles();
        if (activeProfiles.length > 0) {
            values.put("springActiveProfiles", String.join(",", activeProfiles));
        }
        return values;
    }

    private static ch.qos.logback.classic.Logger logbackLogger(String name) {
        LoggerContext context = (LoggerContext) LoggerFactory.getILoggerFactory();
        return context.getLogger(name);
    }

    private static void require(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError(label);
        }
    }

    private static int occurrences(String value, String needle) {
        int count = 0;
        int cursor = 0;
        while (true) {
            int index = value.indexOf(needle, cursor);
            if (index < 0) {
                return count;
            }
            count++;
            cursor = index + needle.length();
        }
    }

    @RestController
    static final class CheckoutController {
        private final DataSource dataSource;

        CheckoutController(DataSource dataSource) {
            this.dataSource = dataSource;
        }

        @PostMapping("/checkout/{cartId}")
        ResponseEntity<String> checkout(@PathVariable("cartId") String cartId) throws Exception {
            require(!cartId.isEmpty(), "Spring path variable is available to app code");
            require(
                dataSource.toString().contains("LogBrewJdbcTracing"),
                "Spring controller receives wrapped DataSource"
            );
            Connection connection = dataSource.getConnection("jdbc_user_fixture", "jdbc_pass_fixture");
            connection
                .createStatement()
                .executeQuery("SELECT synthetic_column FROM orders WHERE lookup_key = 'synthetic_value'");
            connection.commit();
            require(CLIENT.previewJson().contains("jdbc:SELECT"), "Spring controller queues JDBC spans");
            logbackLogger("app.checkout")
                .atInfo()
                .addKeyValue("routeVerified", Boolean.TRUE)
                .log("spring boot checkout request");
            return ResponseEntity.accepted().body("accepted");
        }
    }

    private static DataSource fakeDataSource() {
        return proxy(DataSource.class, (proxy, method, args) -> {
            if ("getConnection".equals(method.getName())) {
                return fakeConnection();
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection fakeConnection() {
        return proxy(Connection.class, (proxy, method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return fakeStatement();
            }
            if ("commit".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Statement fakeStatement() {
        return proxy(Statement.class, (proxy, method, args) -> {
            if (method.getName().startsWith("execute")) {
                return fakeResultSet();
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet fakeResultSet() {
        return proxy(ResultSet.class, (proxy, method, args) -> defaultValue(method.getReturnType()));
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<?> interfaceType, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(
            interfaceType.getClassLoader(),
            new Class<?>[] {interfaceType},
            (proxy, method, args) -> {
                if ("toString".equals(method.getName()) && method.getParameterCount() == 0) {
                    return interfaceType.getSimpleName() + "Proxy";
                }
                if ("hashCode".equals(method.getName()) && method.getParameterCount() == 0) {
                    return Integer.valueOf(System.identityHashCode(proxy));
                }
                if ("equals".equals(method.getName()) && method.getParameterCount() == 1) {
                    return Boolean.valueOf(proxy == args[0]);
                }
                return handler.invoke(proxy, method, args == null ? new Object[0] : args);
            }
        );
    }

    private static Object defaultValue(Class<?> type) {
        if (type == void.class) {
            return null;
        }
        if (type == boolean.class) {
            return Boolean.FALSE;
        }
        if (type == int.class) {
            return Integer.valueOf(0);
        }
        if (type == long.class) {
            return Long.valueOf(0L);
        }
        if (type == double.class) {
            return Double.valueOf(0.0);
        }
        if (type == float.class) {
            return Float.valueOf(0.0f);
        }
        if (type == short.class) {
            return Short.valueOf((short) 0);
        }
        if (type == byte.class) {
            return Byte.valueOf((byte) 0);
        }
        if (type == char.class) {
            return Character.valueOf('\0');
        }
        return null;
    }
}
JAVA

run_gradle() {
  (cd "$gradle_app" && GRADLE_USER_HOME="$gradle_home" gradle --no-daemon -q "$@")
}

run_gradle dependencies --configuration runtimeClasspath > "$tmp_dir/gradle-deps.txt"
grep -q 'co.logbrew:logbrew-sdk:0.1.0' "$tmp_dir/gradle-deps.txt"
grep -q "org.springframework.boot:spring-boot-starter:$spring_boot_version" "$tmp_dir/gradle-deps.txt"
grep -q "org.springframework.boot:spring-boot-starter-web:$spring_boot_version" "$tmp_dir/gradle-deps.txt"
grep -q 'ch.qos.logback:logback-classic' "$tmp_dir/gradle-deps.txt"

run_gradle compileJava
if run_gradle run > "$tmp_dir/spring-boot.stdout.json" 2> "$tmp_dir/spring-boot.stderr.json"; then
  :
else
  status=$?
  print_failure_diagnostics "$status"
  exit "$status"
fi
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/spring-boot.stdout.json" >/dev/null
grep -q '"source": "logback"' "$tmp_dir/spring-boot.stdout.json"
grep -q '"source": "jakarta-servlet"' "$tmp_dir/spring-boot.stdout.json"
grep -q '"springApplicationName": "checkout-service"' "$tmp_dir/spring-boot.stdout.json"
grep -q '"mdc.traceId": "trace_123"' "$tmp_dir/spring-boot.stdout.json"
grep -q '"kv.cartId": 42' "$tmp_dir/spring-boot.stdout.json"
grep -q '"name": "POST /checkout/{cartId}"' "$tmp_dir/spring-boot.stdout.json"
grep -q '"routeSource": "spring_best_matching_pattern"' "$tmp_dir/spring-boot.stdout.json"
grep -q '"parentSpanId": "00f067aa0ba902b7"' "$tmp_dir/spring-boot.stdout.json"
grep -q '"source": "jdbc.statement"' "$tmp_dir/spring-boot.stdout.json"
grep -q '"name": "jdbc:SELECT"' "$tmp_dir/spring-boot.stdout.json"
grep -q '"ok":true' "$tmp_dir/spring-boot.stderr.json"
grep -q '"events":8' "$tmp_dir/spring-boot.stderr.json"

echo "spring boot real-user smoke passed with spring-boot@$spring_boot_version"

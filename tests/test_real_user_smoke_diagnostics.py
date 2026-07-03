import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RealUserSmokeDiagnosticsTests(unittest.TestCase):
    def test_kotlin_smoke_dumps_bounded_diagnostics_on_failure(self):
        script = (ROOT / "scripts" / "real_user_kotlin_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn("on_error()", script)
        self.assertIn("trap on_error ERR", script)
        self.assertIn("real_user_kotlin_smoke failed at line", script)
        self.assertIn("${BASH_COMMAND}", script)
        self.assertIn("sed -n '1,120p'", script)
        self.assertIn('"$tmp_dir/gradle-deps.txt"', script)
        self.assertIn('"$tmp_dir/okhttp-app.out"', script)
        self.assertIn('"$tmp_dir/intake.jsonl"', script)

    def test_kotlin_smoke_waits_for_fake_intake_readiness_without_masking_exit(self):
        script = (ROOT / "scripts" / "real_user_kotlin_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn("wait_for_intake_ready()", script)
        self.assertIn("local attempts=300", script)
        self.assertIn('kill -0 "$intake_pid"', script)
        self.assertIn("Kotlin fake intake exited before readiness", script)
        self.assertIn("Kotlin fake intake did not become ready", script)
        self.assertNotIn("for _attempt in {1..50}", script)

    def test_kotlin_smoke_base_gradle_app_resolves_runtime_dependencies(self):
        script = (ROOT / "scripts" / "real_user_kotlin_smoke.sh").read_text(
            encoding="utf-8"
        )

        base_gradle_build = script.split('cat > "$gradle_app/build.gradle" <<EOF', 1)[1]
        base_gradle_build = base_gradle_build.split("EOF", 1)[0]

        self.assertIn("url = uri('$tmp_dir/maven')", base_gradle_build)
        self.assertIn("mavenCentral()", base_gradle_build)

    def test_kotlin_smoke_reads_current_package_versions_from_poms(self):
        script = (ROOT / "scripts" / "real_user_kotlin_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn('kotlin_version="$(read_pom_version "$package_dir/pom.xml")"', script)
        self.assertIn('okhttp_version="$(read_pom_version "$okhttp_package_dir/pom.xml")"', script)
        self.assertIn('logbrew-kotlin-$kotlin_version.jar', script)
        self.assertIn('logbrew-kotlin-okhttp-$okhttp_version.jar', script)
        self.assertIn("co.logbrew:logbrew-kotlin:$kotlin_version", script)
        self.assertIn("co.logbrew:logbrew-kotlin-okhttp:$okhttp_version", script)

        self.assertNotIn("co.logbrew:logbrew-kotlin:0.1.0", script)
        self.assertNotIn("co.logbrew:logbrew-kotlin-okhttp:0.1.0", script)

    def test_java_smoke_reads_current_package_version_from_pom(self):
        script = (ROOT / "scripts" / "real_user_java_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn('java_version="$(read_pom_version "$package_dir/pom.xml")"', script)
        self.assertIn('java_jar="$tmp_dir/logbrew-sdk-$java_version.jar"', script)
        self.assertIn(
            'java_sources_jar="$tmp_dir/logbrew-sdk-$java_version-sources.jar"',
            script,
        )
        self.assertIn('logbrew-sdk-$java_version.jar', script)
        self.assertIn('logbrew-sdk-$java_version-sources.jar', script)
        self.assertIn('<version>${java_version}</version>', script)

        self.assertNotIn('java_jar="$java_jar"', script)
        self.assertNotIn('java_sources_jar="$java_sources_jar"', script)
        self.assertNotIn("logbrew-sdk-0.1.0.jar", script)
        self.assertNotIn("logbrew-sdk-0.1.0-sources.jar", script)
        self.assertNotIn("<version>0.1.0</version>", script)

    def test_spring_boot_smoke_reads_current_java_package_version_from_pom(self):
        script = (ROOT / "scripts" / "real_user_spring_boot_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn('java_version="$(read_pom_version "$package_dir/pom.xml")"', script)
        self.assertIn('java_jar="$tmp_dir/logbrew-sdk-$java_version.jar"', script)
        self.assertIn("logbrew-sdk-$java_version.jar", script)
        self.assertIn("co.logbrew:logbrew-sdk:$java_version", script)

        self.assertNotIn("co.logbrew:logbrew-sdk:0.1.0", script)
        self.assertNotIn("logbrew-sdk-0.1.0.jar", script)

    def test_spring_boot_jdbc_auto_configuration_registers_before_datasource_creation(self):
        auto_config = (
            ROOT
            / "java"
            / "logbrew-java"
            / "src"
            / "main"
            / "java"
            / "co"
            / "logbrew"
            / "sdk"
            / "LogBrewSpringBootJdbcAutoConfiguration.java"
        ).read_text(encoding="utf-8")
        post_processor = (
            ROOT
            / "java"
            / "logbrew-java"
            / "src"
            / "main"
            / "java"
            / "co"
            / "logbrew"
            / "sdk"
            / "LogBrewSpringBootJdbcDataSourcePostProcessor.java"
        ).read_text(encoding="utf-8")

        self.assertIn("@AutoConfiguration(beforeName = {", auto_config)
        self.assertNotIn("@ConditionalOnBean(LogBrewClient.class)", auto_config)
        self.assertIn("postProcessBeforeInitialization", post_processor)
        self.assertIn("postProcessAfterInitialization", post_processor)
        self.assertIn("LogBrewClient client = clientProvider.getIfAvailable()", post_processor)


if __name__ == "__main__":
    unittest.main()

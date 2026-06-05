.PHONY: help run run-readme-example run-real-user-smoke

PACKAGE_DIR := $(abspath ..)

help:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'

run: run-real-user-smoke

run-readme-example:
	@tmp_dir="$$(mktemp -d)" && trap 'rm -rf "$$tmp_dir"' EXIT && kotlinc "$(PACKAGE_DIR)"/src/main/kotlin/co/logbrew/sdk/*.kt "$(PACKAGE_DIR)"/examples/readme_example/ReadmeExample.kt -jvm-target 11 -Werror -include-runtime -d "$$tmp_dir/readme-example.jar" && java -jar "$$tmp_dir/readme-example.jar"

run-real-user-smoke:
	@tmp_dir="$$(mktemp -d)" && trap 'rm -rf "$$tmp_dir"' EXIT && kotlinc "$(PACKAGE_DIR)"/src/main/kotlin/co/logbrew/sdk/*.kt "$(PACKAGE_DIR)"/examples/readme_example/ReadmeExample.kt "$(PACKAGE_DIR)"/examples/real_user_smoke/RealUserSmoke.kt -jvm-target 11 -Werror -include-runtime -Xjdk-release=11 -d "$$tmp_dir/real-user-smoke.jar" && java -cp "$$tmp_dir/real-user-smoke.jar" RealUserSmokeKt

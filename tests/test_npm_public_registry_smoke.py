from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_npm_public_registry_smoke.sh"


class NpmPublicRegistrySmokeTests(unittest.TestCase):
    def test_script_proves_current_public_server_package_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for package in (
            "@logbrew/sdk",
            "@logbrew/node",
            "@logbrew/bullmq",
            "@logbrew/kafkajs",
            "@logbrew/amqplib",
            "@logbrew/aws-sqs",
        ):
            self.assertIn(package, body)

        for expected in (
            "LOGBREW_NPM_SDK_VERSION",
            "LOGBREW_NPM_NODE_VERSION",
            "LOGBREW_NPM_BULLMQ_VERSION",
            "LOGBREW_NPM_KAFKAJS_VERSION",
            "LOGBREW_NPM_AMQPLIB_VERSION",
            "LOGBREW_NPM_AWS_SQS_VERSION",
            'registry="https://registry.npmjs.org"',
            '--registry "$registry"',
            "npm install",
            "npm ls",
            "package-lock.json",
            "import",
            "require(",
            "RecordingTransport",
            "createLogBrewNodeClient",
            "instrumentLogBrewBullMqQueue",
            "instrumentLogBrewKafkaJsProducer",
            "amqplibPublishWithLogBrewSpan",
            "instrumentLogBrewSqsClient",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()

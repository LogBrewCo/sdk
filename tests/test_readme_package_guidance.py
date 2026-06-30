from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"


class ReadmePackageGuidanceTests(unittest.TestCase):
    def test_node_queue_integrations_are_described_as_published_packages(self) -> None:
        readme = README.read_text(encoding="utf-8")

        for stale_phrase in (
            "will be installable from npm after their",
            "Until their npm package pages exist",
            "use a local checkout when evaluating those helpers",
        ):
            self.assertNotIn(stale_phrase, readme)

        for package_name in (
            "@logbrew/node",
            "@logbrew/bullmq",
            "@logbrew/kafkajs",
            "@logbrew/amqplib",
            "@logbrew/aws-sqs",
        ):
            self.assertIn(package_name, readme)


if __name__ == "__main__":
    unittest.main()

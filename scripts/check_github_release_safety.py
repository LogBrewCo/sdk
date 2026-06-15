#!/usr/bin/env python3
"""Verify GitHub branch and environment settings that guard package publishing."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_REPO = "LogBrewCo/sdk"
DEFAULT_BRANCH = "main"
DEFAULT_ENVIRONMENT = "release"
DEFAULT_REQUIRED_CONTEXT = "Contract checks"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def gh_api(path: str) -> Any:
    if shutil.which("gh") is None:
        raise RuntimeError("GitHub CLI `gh` is required when fixture JSON files are not provided")
    result = subprocess.run(
        ["gh", "api", path],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"gh api {path} failed: {detail}")
    return json.loads(result.stdout)


def enabled_flag(payload: Any, key: str) -> bool | None:
    if not isinstance(payload, dict):
        return None
    value = payload.get(key)
    if not isinstance(value, dict) or not isinstance(value.get("enabled"), bool):
        return None
    return value["enabled"]


def required_status_contexts(branch_protection: Any) -> set[str]:
    if not isinstance(branch_protection, dict):
        return set()
    required_status_checks = branch_protection.get("required_status_checks")
    if not isinstance(required_status_checks, dict):
        return set()

    contexts = {
        context
        for context in required_status_checks.get("contexts", [])
        if isinstance(context, str) and context
    }
    checks = required_status_checks.get("checks", [])
    if isinstance(checks, list):
        contexts.update(
            check.get("context")
            for check in checks
            if isinstance(check, dict) and isinstance(check.get("context"), str)
        )
    return contexts


def validate_branch_protection(
    branch_protection: Any,
    *,
    branch: str,
    required_context: str,
) -> list[str]:
    failures: list[str] = []
    if not isinstance(branch_protection, dict):
        return [f"{branch}: branch protection response is not an object"]

    required_status_checks = branch_protection.get("required_status_checks")
    if not isinstance(required_status_checks, dict):
        failures.append(f"{branch}: required status checks are not enabled")
    else:
        if required_status_checks.get("strict") is not True:
            failures.append(f"{branch}: required status checks must be strict")
        if required_context not in required_status_contexts(branch_protection):
            failures.append(f"{branch}: required status check {required_context!r} is missing")

    force_pushes_enabled = enabled_flag(branch_protection, "allow_force_pushes")
    if force_pushes_enabled is None:
        failures.append(f"{branch}: force-push protection state is missing")
    elif force_pushes_enabled:
        failures.append(f"{branch}: force pushes must stay disabled")

    deletion_enabled = enabled_flag(branch_protection, "allow_deletions")
    if deletion_enabled is None:
        failures.append(f"{branch}: branch-deletion protection state is missing")
    elif deletion_enabled:
        failures.append(f"{branch}: branch deletion must stay disabled")
    return failures


def validate_environment(environment: Any, *, environment_name: str) -> list[str]:
    failures: list[str] = []
    if not isinstance(environment, dict):
        return [f"{environment_name}: environment response is not an object"]

    if environment.get("name") != environment_name:
        failures.append(f"{environment_name}: environment name did not match response")

    deployment_branch_policy = environment.get("deployment_branch_policy")
    if not isinstance(deployment_branch_policy, dict):
        failures.append(f"{environment_name}: deployment branch policy is not enabled")
    else:
        if deployment_branch_policy.get("protected_branches") is not True:
            failures.append(f"{environment_name}: deployments must be restricted to protected branches")
        if deployment_branch_policy.get("custom_branch_policies") is not False:
            failures.append(f"{environment_name}: custom branch policies should stay disabled")

    protection_rules = environment.get("protection_rules", [])
    if not isinstance(protection_rules, list) or not any(
        isinstance(rule, dict) and rule.get("type") == "branch_policy" for rule in protection_rules
    ):
        failures.append(f"{environment_name}: branch policy protection rule is missing")
    return failures


def release_safety_failures(
    branch_protection: Any,
    environment: Any,
    *,
    branch: str = DEFAULT_BRANCH,
    environment_name: str = DEFAULT_ENVIRONMENT,
    required_context: str = DEFAULT_REQUIRED_CONTEXT,
) -> list[str]:
    return [
        *validate_branch_protection(
            branch_protection,
            branch=branch,
            required_context=required_context,
        ),
        *validate_environment(environment, environment_name=environment_name),
    ]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check the GitHub branch and environment protections required before package publishing."
    )
    parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub repository, for example LogBrewCo/sdk.")
    parser.add_argument("--branch", default=DEFAULT_BRANCH, help="Protected branch name.")
    parser.add_argument("--environment", default=DEFAULT_ENVIRONMENT, help="GitHub Actions environment name.")
    parser.add_argument(
        "--required-context",
        default=DEFAULT_REQUIRED_CONTEXT,
        help="Required branch status-check context.",
    )
    parser.add_argument(
        "--branch-protection-json",
        type=Path,
        help="Fixture JSON for branch protection; skips the GitHub API branch call.",
    )
    parser.add_argument(
        "--environment-json",
        type=Path,
        help="Fixture JSON for the environment; skips the GitHub API environment call.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        branch_protection = (
            read_json(args.branch_protection_json)
            if args.branch_protection_json
            else gh_api(f"repos/{args.repo}/branches/{args.branch}/protection")
        )
        environment = (
            read_json(args.environment_json)
            if args.environment_json
            else gh_api(f"repos/{args.repo}/environments/{args.environment}")
        )
        failures = release_safety_failures(
            branch_protection,
            environment,
            branch=args.branch,
            environment_name=args.environment,
            required_context=args.required_context,
        )
    except Exception as exc:
        print(f"GitHub release safety check failed: {exc}", file=sys.stderr)
        return 1

    if failures:
        print("GitHub release safety check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print(
        "GitHub release safety ok: "
        f"{args.branch} requires {args.required_context!r}, force pushes/deletion are disabled, "
        f"and {args.environment!r} deploys only from protected branches."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

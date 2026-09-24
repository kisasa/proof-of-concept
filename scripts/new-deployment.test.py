#!/usr/bin/env python3
"""Regression tests for scripts/new-deployment.py.

Usage: python3 scripts/new-deployment.test.py

Two halves. The pure functions — naming, the case-preserving rename, the CIDR
arithmetic, the pre-write validation — need nothing installed, same as the part
of the script they cover. The rename and the CIDR choice are where a hand-done
copy goes wrong quietly, so both run against a config shaped exactly like a real
one, including the detail that one deployment name appears in two different
cases within the same file.

The AWS calls are covered with `botocore`'s `Stubber`, which validates every
request against the service's own model. That catches the one failure mode
reading the code does not — a misspelled key or a wrongly nested argument, which
would otherwise surface only on a real apply against a real account. Those tests
skip when boto3 is absent rather than failing, so generating a config stays a
no-install operation.
"""
import ast
import importlib.util
import io
import ipaddress
import json
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parent / "new-deployment.py"

# The script imports boto3 only when the AWS steps are reached, so the pure tests run
# without it. The stubbed tests below cannot, and skip rather than fail: someone who
# only wants to generate a config should not have to install anything to run this.
try:
    import boto3
    from botocore.stub import Stubber

    BOTO3_INSTALLED = True
except ImportError:
    BOTO3_INSTALLED = False

# The module's filename is not a Python identifier, matching the repository's
# other scripts, so it is loaded by path rather than imported by name. Loading it
# this way is also the only thing in the repository that would write a
# `scripts/__pycache__/`, for a module imported exactly once per run.
sys.dont_write_bytecode = True
_specification = importlib.util.spec_from_file_location("new_deployment", SCRIPT_PATH)
new_deployment = importlib.util.module_from_spec(_specification)
_specification.loader.exec_module(new_deployment)


def base_config():
    """A config with the same key set and the same two casings as a real one."""
    return {
        "language": "typescript",
        "app": "npx tsx main.ts",
        "output": "PROJ0903.out",
        "terraformProviders": ["temporalio/temporalcloud@~> 0"],
        "context": {
            "aws": {
                "region": "us-east-1",
                "account-number": "000000000000",
                "profile": "example",
            },
            "state-bucket-name": "proj0903-intent-tfstate",
            "global-tags": {
                "terraform": "true",
                "project": "intent-to-production",
                "environment": "PROJ0903",
            },
            "domain-name": "example.com",
            "hosted-zone-id": "Z0000000000000000000",
            "vpc-cidr-block": "10.12.0.0/22",
            "parameter-prefix": "/example/proj0903/",
            "resource-name-prefix": "proj0903",
            "listener": {
                "environment-name": "PROJ0903",
                "subdomain": "intent",
                "port": 8787,
                "linear-api-url": None,
                "claude-effort": "high",
            },
            "specialist-sandbox": {
                "environment-name": "PROJ0903",
                "framework-repo": "example-org/intent-to-production",
            },
            "temporal": {
                "environment-name": "PROJ0903",
                "namespace-name": "intent-to-production-proj0903",
                "reviewer-email-to-github-login": {"user@example.com": "example-login"},
            },
        },
        "projectId": "00000000-0000-4000-8000-000000000001",
    }


class DeploymentNameFromPathTest(unittest.TestCase):
    def test_extracts_the_name_from_a_deployment_config(self):
        self.assertEqual(new_deployment.deployment_name_from_path("cdktf.PROJ0903.json"), "PROJ0903")

    def test_extracts_the_template_name(self):
        self.assertEqual(new_deployment.deployment_name_from_path("cdktf.example.json"), "example")

    def test_reads_the_name_out_of_a_full_path(self):
        self.assertEqual(
            new_deployment.deployment_name_from_path("/tmp/infrastructure/cdktf.PROJ0903.json"),
            "PROJ0903",
        )

    def test_ignores_the_active_config(self):
        """`cdktf.json` is the renamed stand-in for a run, never a deployment of its own."""
        self.assertIsNone(new_deployment.deployment_name_from_path("cdktf.json"))

    def test_ignores_an_unrelated_file(self):
        self.assertIsNone(new_deployment.deployment_name_from_path("package.json"))


class BuildDeploymentNameTest(unittest.TestCase):
    def test_joins_team_id_and_month_day(self):
        self.assertEqual(new_deployment.build_deployment_name("PROJ", "0903"), "PROJ0903")

    def test_uppercases_the_team_id(self):
        self.assertEqual(new_deployment.build_deployment_name("proj", "0903"), "PROJ0903")

    def test_accepts_digits_in_the_team_id(self):
        self.assertEqual(new_deployment.build_deployment_name("PROJDEV2", "0908"), "PROJDEV20908")

    def test_rejects_a_team_id_starting_with_a_digit(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.build_deployment_name("2PROJ", "0903")

    def test_rejects_a_month_out_of_range(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.build_deployment_name("PROJ", "1303")

    def test_rejects_a_day_out_of_range(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.build_deployment_name("PROJ", "0932")

    def test_rejects_a_date_that_is_not_four_digits(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.build_deployment_name("PROJ", "93")

    def test_accepts_a_name_right_at_the_environment_name_cap(self):
        self.assertEqual(len(new_deployment.build_deployment_name("A" * 26, "0903")), 30)

    def test_rejects_a_name_over_the_environment_name_cap(self):
        """Load balancer and target group names cap at 32; environment-name at 30."""
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.build_deployment_name("A" * 27, "0903")


class RenameDeploymentTest(unittest.TestCase):
    def test_preserves_an_uppercase_site(self):
        self.assertEqual(new_deployment.rename_deployment("PROJ0903", "PROJ0903", "TEAM1015"), "TEAM1015")

    def test_preserves_a_lowercase_site(self):
        self.assertEqual(
            new_deployment.rename_deployment("proj0903-intent-tfstate", "PROJ0903", "TEAM1015"),
            "team1015-intent-tfstate",
        )

    def test_renames_both_cases_from_one_call(self):
        self.assertEqual(
            new_deployment.rename_deployment("PROJ0903 and proj0903", "PROJ0903", "TEAM1015"),
            "TEAM1015 and team1015",
        )

    def test_matches_the_base_name_regardless_of_the_case_it_was_given_in(self):
        self.assertEqual(
            new_deployment.rename_deployment("proj0903", "proj0903", "team1015"),
            "team1015",
        )

    def test_falls_back_to_the_name_as_typed_for_a_mixed_case_site(self):
        self.assertEqual(
            new_deployment.rename_deployment("Proj0903", "PROJ0903", "TEAM1015"),
            "TEAM1015",
        )

    def test_renames_inside_a_path(self):
        self.assertEqual(
            new_deployment.rename_deployment("/example/proj0903/", "PROJ0903", "TEAM1015"),
            "/example/team1015/",
        )

    def test_leaves_a_string_without_the_name_alone(self):
        self.assertEqual(
            new_deployment.rename_deployment("intent-to-production", "PROJ0903", "TEAM1015"),
            "intent-to-production",
        )


class RenameDeploymentInConfigTest(unittest.TestCase):
    def setUp(self):
        self.renamed, self.renamed_sites = new_deployment.rename_deployment_in_config(
            base_config(), "PROJ0903", "TEAM1015"
        )

    def test_renames_the_uppercase_sites(self):
        context = self.renamed["context"]
        self.assertEqual(self.renamed["output"], "TEAM1015.out")
        self.assertEqual(context["global-tags"]["environment"], "TEAM1015")
        self.assertEqual(context["listener"]["environment-name"], "TEAM1015")
        self.assertEqual(context["specialist-sandbox"]["environment-name"], "TEAM1015")
        self.assertEqual(context["temporal"]["environment-name"], "TEAM1015")

    def test_renames_the_lowercase_sites(self):
        context = self.renamed["context"]
        self.assertEqual(context["state-bucket-name"], "team1015-intent-tfstate")
        self.assertEqual(context["parameter-prefix"], "/example/team1015/")
        self.assertEqual(context["resource-name-prefix"], "team1015")
        self.assertEqual(context["temporal"]["namespace-name"], "intent-to-production-team1015")

    def test_counts_every_renamed_value(self):
        self.assertEqual(self.renamed_sites, 9)

    def test_leaves_the_rest_of_the_config_alone(self):
        context = self.renamed["context"]
        self.assertEqual(context["aws"], base_config()["context"]["aws"])
        self.assertEqual(context["domain-name"], "example.com")
        self.assertEqual(context["listener"]["port"], 8787)
        self.assertIsNone(context["listener"]["linear-api-url"])
        self.assertEqual(self.renamed["projectId"], base_config()["projectId"])

    def test_leaves_the_reviewer_table_keys_alone(self):
        """The reviewer table's keys are email addresses, not rename sites."""
        self.assertEqual(
            self.renamed["context"]["temporal"]["reviewer-email-to-github-login"],
            {"user@example.com": "example-login"},
        )

    def test_does_not_mutate_the_config_it_was_given(self):
        original = base_config()
        new_deployment.rename_deployment_in_config(original, "PROJ0903", "TEAM1015")
        self.assertEqual(original, base_config())

    def test_carries_whatever_the_base_had_drifted_to(self):
        """Inheriting the base's shape is the contract, including its irregularities."""
        drifted = base_config()
        drifted["context"]["temporal"]["namespace-name"] = "itp-proj0903"

        renamed, _ = new_deployment.rename_deployment_in_config(drifted, "PROJ0903", "TEAM1015")

        self.assertEqual(renamed["context"]["temporal"]["namespace-name"], "itp-team1015")


class ValidateGeneratedConfigTest(unittest.TestCase):
    def renamed_config(self):
        renamed, _ = new_deployment.rename_deployment_in_config(base_config(), "PROJ0903", "TEAM1015")
        return renamed

    def test_a_clean_rename_has_no_problems(self):
        self.assertEqual(
            new_deployment.validate_generated_config(self.renamed_config(), "PROJ0903", "TEAM1015"),
            [],
        )

    def test_catches_a_leftover_base_name(self):
        config = self.renamed_config()
        config["context"]["listener"]["subdomain"] = "intent-proj0903"

        problems = new_deployment.validate_generated_config(config, "PROJ0903", "TEAM1015")

        self.assertTrue(any("still appears" in problem for problem in problems))

    def test_catches_an_output_directory_that_does_not_match(self):
        config = self.renamed_config()
        config["output"] = "cdktf.out"

        problems = new_deployment.validate_generated_config(config, "PROJ0903", "TEAM1015")

        self.assertTrue(any(problem.startswith("output is") for problem in problems))

    def test_catches_a_state_bucket_that_did_not_pick_up_the_new_name(self):
        config = self.renamed_config()
        config["context"]["state-bucket-name"] = "shared-intent-tfstate"

        problems = new_deployment.validate_generated_config(config, "PROJ0903", "TEAM1015")

        self.assertTrue(any(problem.startswith("state-bucket-name is") for problem in problems))

    def test_catches_a_missing_key(self):
        config = self.renamed_config()
        del config["context"]["resource-name-prefix"]

        problems = new_deployment.validate_generated_config(config, "PROJ0903", "TEAM1015")

        self.assertIn("resource-name-prefix is missing or not a string", problems)

    def test_catches_an_environment_name_over_the_cap(self):
        long_name = "T" * 31
        config = self.renamed_config()
        config["output"] = f"{long_name}.out"
        config["context"]["listener"]["environment-name"] = long_name

        problems = new_deployment.validate_generated_config(config, "PROJ0903", long_name)

        self.assertTrue(any("over the 30 cap" in problem for problem in problems))


class UsedCidrBlocksTest(unittest.TestCase):
    def write_config(self, directory, name, cidr_block):
        path = Path(directory) / name
        config = base_config()

        if cidr_block is None:
            del config["context"]["vpc-cidr-block"]
        else:
            config["context"]["vpc-cidr-block"] = cidr_block

        path.write_text(json.dumps(config), encoding="utf-8")
        return path

    def test_collects_every_block_in_order(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [
                self.write_config(directory, "cdktf.B.json", "10.13.0.0/22"),
                self.write_config(directory, "cdktf.A.json", "10.9.0.0/22"),
            ]

            self.assertEqual(
                new_deployment.used_cidr_blocks(paths),
                [ipaddress.IPv4Network("10.9.0.0/22"), ipaddress.IPv4Network("10.13.0.0/22")],
            )

    def test_skips_a_config_with_no_block(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [
                self.write_config(directory, "cdktf.A.json", None),
                self.write_config(directory, "cdktf.B.json", "10.9.0.0/22"),
            ]

            self.assertEqual(
                new_deployment.used_cidr_blocks(paths), [ipaddress.IPv4Network("10.9.0.0/22")]
            )

    def test_skips_unreadable_and_malformed_files(self):
        """A half-written config beside the base must not stop a new deployment."""
        with tempfile.TemporaryDirectory() as directory:
            broken = Path(directory) / "cdktf.BROKEN.json"
            broken.write_text("{ not json", encoding="utf-8")
            paths = [
                broken,
                Path(directory) / "cdktf.MISSING.json",
                self.write_config(directory, "cdktf.BAD.json", "10.9.0.1/22"),
                self.write_config(directory, "cdktf.GOOD.json", "10.9.0.0/22"),
            ]

            self.assertEqual(
                new_deployment.used_cidr_blocks(paths), [ipaddress.IPv4Network("10.9.0.0/22")]
            )


class NextFreeCidrBlockTest(unittest.TestCase):
    def test_starts_at_the_bottom_of_the_range_when_nothing_is_in_use(self):
        self.assertEqual(
            new_deployment.next_free_cidr_block([]), ipaddress.IPv4Network("10.0.0.0/22")
        )

    def test_moves_above_the_highest_block_rather_than_filling_a_gap(self):
        used = [
            ipaddress.IPv4Network("10.9.0.0/22"),
            ipaddress.IPv4Network("10.12.0.0/22"),
            ipaddress.IPv4Network("10.13.0.0/22"),
        ]

        self.assertEqual(
            new_deployment.next_free_cidr_block(used), ipaddress.IPv4Network("10.14.0.0/22")
        )

    def test_steps_the_second_octet_rather_than_packing_into_the_rest_of_a_block(self):
        """`10.13.4.0/22` is free and adjacent; the convention is a fresh octet."""
        self.assertEqual(
            new_deployment.next_free_cidr_block([ipaddress.IPv4Network("10.13.0.0/22")]),
            ipaddress.IPv4Network("10.14.0.0/22"),
        )

    def test_steps_past_a_block_wider_than_a_slash_22(self):
        used = [ipaddress.IPv4Network("10.20.0.0/16")]

        self.assertEqual(
            new_deployment.next_free_cidr_block(used), ipaddress.IPv4Network("10.21.0.0/22")
        )

    def test_ignores_a_block_outside_the_private_range_when_suggesting(self):
        used = [ipaddress.IPv4Network("192.168.0.0/22"), ipaddress.IPv4Network("10.9.0.0/22")]

        self.assertEqual(
            new_deployment.next_free_cidr_block(used), ipaddress.IPv4Network("10.10.0.0/22")
        )

    def test_refuses_once_the_range_is_exhausted(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.next_free_cidr_block([ipaddress.IPv4Network("10.255.252.0/22")])


class ParseCidrChoiceTest(unittest.TestCase):
    def test_accepts_a_free_block(self):
        self.assertEqual(
            new_deployment.parse_cidr_choice("10.14.0.0/22", [ipaddress.IPv4Network("10.13.0.0/22")]),
            ipaddress.IPv4Network("10.14.0.0/22"),
        )

    def test_rejects_an_exact_collision(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.parse_cidr_choice("10.13.0.0/22", [ipaddress.IPv4Network("10.13.0.0/22")])

    def test_rejects_a_block_inside_a_wider_one_already_in_use(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.parse_cidr_choice("10.13.0.0/22", [ipaddress.IPv4Network("10.12.0.0/15")])

    def test_rejects_a_prefix_length_the_stacks_cannot_split(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.parse_cidr_choice("10.14.0.0/24", [])

    def test_rejects_a_host_address_rather_than_a_network(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.parse_cidr_choice("10.14.0.1/22", [])

    def test_rejects_something_that_is_not_an_address(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.parse_cidr_choice("not-a-cidr", [])


class ParseArgumentsTest(unittest.TestCase):
    def test_takes_the_team_id_as_a_positional(self):
        self.assertEqual(new_deployment.parse_arguments(["PROJ"]).team_id, "PROJ")

    def test_leaves_the_team_id_unset_to_be_prompted_for(self):
        self.assertIsNone(new_deployment.parse_arguments([]).team_id)

    def test_passes_the_team_id_through_unchanged_for_validation(self):
        """Casing and shape are `build_deployment_name`'s to judge, wherever the id came from."""
        self.assertEqual(new_deployment.parse_arguments(["proj"]).team_id, "proj")

    def test_rejects_a_second_positional(self):
        with self.assertRaises(SystemExit):
            new_deployment.parse_arguments(["PROJ", "0903"])


class PrintedTextIsAsciiTest(unittest.TestCase):
    """The prose in this repository uses em dashes; a Windows console cannot print one.

    Under a legacy code page an em dash arrives as a replacement character in the
    middle of instructions someone is about to paste. Checked over the syntax tree
    rather than by capturing one run, so a message added later is covered without
    the test having to reach the branch that prints it.
    """

    SPEAKING_CALLS = frozenset(
        {"print", "ask", "confirm", "DeploymentError", "ArgumentParser", "add_argument"}
    )

    @staticmethod
    def called_name(node):
        """`print(...)` and `parser.add_argument(...)` alike; argparse help text also prints."""
        if isinstance(node.func, ast.Name):
            return node.func.id

        if isinstance(node.func, ast.Attribute):
            return node.func.attr

        return None

    def test_every_literal_headed_for_the_terminal_is_ascii(self):
        tree = ast.parse(SCRIPT_PATH.read_text(encoding="utf-8"))
        offenders = []

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue

            if self.called_name(node) not in self.SPEAKING_CALLS:
                continue

            for literal in ast.walk(node):
                if (
                    isinstance(literal, ast.Constant)
                    and isinstance(literal.value, str)
                    and not literal.value.isascii()
                ):
                    offenders.append(literal.value)

        self.assertEqual(offenders, [])


class TerraformManagedParametersTest(unittest.TestCase):
    def test_the_generated_temporal_key_is_never_copied(self):
        """temporal-workers writes it per apply; a copy points the new workers at the old namespace."""
        self.assertIn("TEMPORAL_API_KEY", new_deployment.TERRAFORM_MANAGED_PARAMETERS)


class StubbedSession:
    """Hands back one prepared client per service, as `boto3.Session.client` would."""

    def __init__(self, clients):
        self.clients = clients

    def client(self, service_name):
        return self.clients[service_name]


def stubbed_client(service_name, region="us-east-1"):
    """A client with credentials that are never used, ready to be stubbed."""
    session = boto3.Session(
        aws_access_key_id="unused", aws_secret_access_key="unused", region_name=region
    )
    client = session.client(service_name, region_name=region)
    return client, Stubber(client)


@unittest.skipUnless(BOTO3_INSTALLED, "boto3 is not installed")
class BuildSessionTest(unittest.TestCase):
    def test_uses_the_profile_the_config_names(self):
        """Never the default profile, and never AWS_PROFILE from the environment."""
        with unittest.mock.patch.object(boto3, "Session") as session:
            new_deployment.build_session(boto3, "example-profile", "eu-west-2")

        session.assert_called_once_with(profile_name="example-profile", region_name="eu-west-2")

    def test_explains_a_profile_that_is_not_configured(self):
        from botocore.exceptions import ProfileNotFound

        with unittest.mock.patch.object(
            boto3, "Session", side_effect=ProfileNotFound(profile="example-profile")
        ):
            with self.assertRaises(new_deployment.DeploymentError) as raised:
                new_deployment.build_session(boto3, "example-profile", "us-east-1")

        self.assertIn("example-profile", str(raised.exception))


@unittest.skipUnless(BOTO3_INSTALLED, "boto3 is not installed")
class VerifyAccountTest(unittest.TestCase):
    """The guard Terraform already has as `allowed_account_ids`, applied before Terraform runs."""

    IDENTITY = {
        "Account": "000000000000",
        "Arn": "arn:aws:iam::000000000000:user/example",
        "UserId": "AIDAEXAMPLE",
    }

    def test_passes_when_the_profile_resolves_to_the_configured_account(self):
        client, stubber = stubbed_client("sts")
        stubber.add_response("get_caller_identity", self.IDENTITY, {})

        with stubber:
            account_number = new_deployment.verify_account(
                StubbedSession({"sts": client}), "000000000000"
            )

        self.assertEqual(account_number, "000000000000")
        stubber.assert_no_pending_responses()

    def test_refuses_an_account_the_config_does_not_name(self):
        client, stubber = stubbed_client("sts")
        stubber.add_response("get_caller_identity", self.IDENTITY, {})

        with stubber, self.assertRaises(new_deployment.DeploymentError) as raised:
            new_deployment.verify_account(StubbedSession({"sts": client}), "999999999999")

        message = str(raised.exception)
        self.assertIn("000000000000", message)
        self.assertIn("999999999999", message)

    def test_compares_as_text_so_an_unquoted_account_number_still_matches(self):
        """JSON would carry a leading-zero account as a string, but nothing enforces that."""
        client, stubber = stubbed_client("sts")
        stubber.add_response(
            "get_caller_identity", {**self.IDENTITY, "Account": "123456789012"}, {}
        )

        with stubber:
            new_deployment.verify_account(StubbedSession({"sts": client}), 123456789012)

    def test_refuses_when_the_config_names_no_account(self):
        with self.assertRaises(new_deployment.DeploymentError):
            new_deployment.verify_account(StubbedSession({}), None)

    def test_reports_credentials_that_cannot_be_resolved(self):
        client, stubber = stubbed_client("sts")
        stubber.add_client_error("get_caller_identity", service_error_code="InvalidClientTokenId")

        with stubber, self.assertRaises(new_deployment.DeploymentError) as raised:
            new_deployment.verify_account(StubbedSession({"sts": client}), "000000000000")

        self.assertIn("identity", str(raised.exception))


@unittest.skipUnless(BOTO3_INSTALLED, "boto3 is not installed")
class CreateStateBucketTest(unittest.TestCase):
    """Stubbed rather than mocked, so every request is validated against S3's own model.

    A misspelled key or a wrongly nested argument is the one failure mode of this code
    that reading it does not catch and that only a real apply would otherwise surface.
    """

    def test_creates_versioned_and_blocked_and_reports_it(self):
        client, stubber = stubbed_client("s3")
        stubber.add_client_error("head_bucket", service_error_code="404", http_status_code=404)
        stubber.add_response("create_bucket", {}, {"Bucket": "example-tfstate"})
        stubber.add_response(
            "put_bucket_versioning",
            {},
            {"Bucket": "example-tfstate", "VersioningConfiguration": {"Status": "Enabled"}},
        )
        stubber.add_response(
            "put_public_access_block",
            {},
            {
                "Bucket": "example-tfstate",
                "PublicAccessBlockConfiguration": {
                    "BlockPublicAcls": True,
                    "IgnorePublicAcls": True,
                    "BlockPublicPolicy": True,
                    "RestrictPublicBuckets": True,
                },
            },
        )

        with stubber:
            result = new_deployment.create_state_bucket(
                StubbedSession({"s3": client}), "example-tfstate", "us-east-1"
            )

        self.assertIn("created example-tfstate", result)
        stubber.assert_no_pending_responses()

    def test_names_the_location_constraint_outside_us_east_1(self):
        """us-east-1 is the only region the API rejects being named explicitly."""
        client, stubber = stubbed_client("s3", region="eu-west-2")
        stubber.add_client_error("head_bucket", service_error_code="404", http_status_code=404)
        stubber.add_response(
            "create_bucket",
            {},
            {
                "Bucket": "example-tfstate",
                "CreateBucketConfiguration": {"LocationConstraint": "eu-west-2"},
            },
        )
        stubber.add_response(
            "put_bucket_versioning",
            {},
            {"Bucket": "example-tfstate", "VersioningConfiguration": {"Status": "Enabled"}},
        )
        stubber.add_response(
            "put_public_access_block",
            {},
            {
                "Bucket": "example-tfstate",
                "PublicAccessBlockConfiguration": {
                    "BlockPublicAcls": True,
                    "IgnorePublicAcls": True,
                    "BlockPublicPolicy": True,
                    "RestrictPublicBuckets": True,
                },
            },
        )

        with stubber:
            new_deployment.create_state_bucket(
                StubbedSession({"s3": client}), "example-tfstate", "eu-west-2"
            )

        stubber.assert_no_pending_responses()

    def test_leaves_an_existing_bucket_alone(self):
        client, stubber = stubbed_client("s3")
        stubber.add_response("head_bucket", {}, {"Bucket": "example-tfstate"})

        with stubber:
            result = new_deployment.create_state_bucket(
                StubbedSession({"s3": client}), "example-tfstate", "us-east-1"
            )

        self.assertIn("already exists", result)
        stubber.assert_no_pending_responses()

    def test_explains_a_name_taken_in_the_global_namespace(self):
        client, stubber = stubbed_client("s3")
        stubber.add_client_error("head_bucket", service_error_code="403", http_status_code=403)

        with stubber, self.assertRaises(new_deployment.DeploymentError) as raised:
            new_deployment.create_state_bucket(
                StubbedSession({"s3": client}), "example-tfstate", "us-east-1"
            )

        self.assertIn("global", str(raised.exception))


@unittest.skipUnless(BOTO3_INSTALLED, "boto3 is not installed")
class PopulateParametersTest(unittest.TestCase):
    SOURCE = "/example/proj0903/"
    TARGET = "/example/team1015/"

    def add_listing(self, stubber, prefix, parameters):
        """A `get_parameters_by_path` page. Always undecrypted: names and types only."""
        stubber.add_response(
            "get_parameters_by_path",
            {
                "Parameters": [
                    {"Name": f"{prefix}{name}", "Type": parameter_type}
                    for name, parameter_type in parameters
                ]
            },
            {"Path": prefix, "Recursive": True, "WithDecryption": False},
        )

    def add_read(self, stubber, name):
        stubber.add_response(
            "get_parameter",
            {"Parameter": {"Name": f"{self.SOURCE}{name}", "Value": f"value-of-{name}"}},
            {"Name": f"{self.SOURCE}{name}", "WithDecryption": True},
        )

    def add_write(self, stubber, name, parameter_type, value):
        stubber.add_response(
            "put_parameter",
            {"Version": 1},
            {"Name": f"{self.TARGET}{name}", "Type": parameter_type, "Value": value},
        )

    def add_prompted_writes(self, stubber, value="typed"):
        """Every prompted credential is asked for on every run, so every run writes them."""
        for name in new_deployment.PROMPTED_PARAMETERS:
            self.add_write(stubber, name, "SecureString", value)

    def test_copies_the_shared_credentials_across(self):
        client, stubber = stubbed_client("ssm")
        self.add_listing(
            stubber,
            self.SOURCE,
            [("GITHUB_TOKEN", "SecureString"), ("LINEAR_AGENT_API_KEY", "SecureString")],
        )
        self.add_listing(stubber, self.TARGET, [])
        self.add_prompted_writes(stubber)
        self.add_read(stubber, "GITHUB_TOKEN")
        self.add_write(stubber, "GITHUB_TOKEN", "SecureString", "value-of-GITHUB_TOKEN")
        self.add_read(stubber, "LINEAR_AGENT_API_KEY")
        self.add_write(
            stubber, "LINEAR_AGENT_API_KEY", "SecureString", "value-of-LINEAR_AGENT_API_KEY"
        )

        with stubber:
            copied, entered, skipped = new_deployment.populate_parameters(
                StubbedSession({"ssm": client}), self.SOURCE, self.TARGET, lambda name: "typed"
            )

        self.assertEqual(copied, ["GITHUB_TOKEN", "LINEAR_AGENT_API_KEY"])
        self.assertEqual(entered, list(new_deployment.PROMPTED_PARAMETERS))
        self.assertEqual(skipped, [])
        stubber.assert_no_pending_responses()

    def test_asks_for_the_per_deployment_credentials_instead_of_copying_them(self):
        client, stubber = stubbed_client("ssm")
        self.add_listing(
            stubber,
            self.SOURCE,
            [
                ("ANTHROPIC_API_KEY", "SecureString"),
                ("temporal-admin/API_KEY", "SecureString"),
                ("GITHUB_TOKEN", "SecureString"),
            ],
        )
        self.add_listing(stubber, self.TARGET, [])
        self.add_write(stubber, "ANTHROPIC_API_KEY", "SecureString", "typed-anthropic")
        self.add_write(stubber, "temporal-admin/API_KEY", "SecureString", "typed-temporal")
        self.add_read(stubber, "GITHUB_TOKEN")
        self.add_write(stubber, "GITHUB_TOKEN", "SecureString", "value-of-GITHUB_TOKEN")

        answers = {"ANTHROPIC_API_KEY": "typed-anthropic", "temporal-admin/API_KEY": "typed-temporal"}
        asked = []

        def answer(name):
            asked.append(name)
            return answers[name]

        with stubber:
            copied, entered, skipped = new_deployment.populate_parameters(
                StubbedSession({"ssm": client}), self.SOURCE, self.TARGET, answer
            )

        self.assertEqual(asked, ["ANTHROPIC_API_KEY", "temporal-admin/API_KEY"])
        self.assertEqual(entered, ["ANTHROPIC_API_KEY", "temporal-admin/API_KEY"])
        self.assertEqual(copied, ["GITHUB_TOKEN"])
        self.assertEqual(skipped, [])
        stubber.assert_no_pending_responses()

    def test_never_decrypts_a_credential_it_is_going_to_ask_for(self):
        """The stub fails any unexpected call, so no `get_parameter` is the assertion.

        Reading the old value would put a credential this deployment must not share
        into memory for no reason.
        """
        client, stubber = stubbed_client("ssm")
        self.add_listing(stubber, self.SOURCE, [("ANTHROPIC_API_KEY", "SecureString")])
        self.add_listing(stubber, self.TARGET, [])
        self.add_prompted_writes(stubber)

        with stubber:
            new_deployment.populate_parameters(
                StubbedSession({"ssm": client}), self.SOURCE, self.TARGET, lambda name: "typed"
            )

        stubber.assert_no_pending_responses()

    def test_asks_for_a_per_deployment_credential_the_source_never_had(self):
        """Enumerated, not discovered: a name absent upstream is still required here."""
        client, stubber = stubbed_client("ssm")
        self.add_listing(stubber, self.SOURCE, [])
        self.add_listing(stubber, self.TARGET, [])
        self.add_write(stubber, "ANTHROPIC_API_KEY", "SecureString", "typed")
        self.add_write(stubber, "temporal-admin/API_KEY", "SecureString", "typed")

        with stubber:
            _, entered, _ = new_deployment.populate_parameters(
                StubbedSession({"ssm": client}), self.SOURCE, self.TARGET, lambda name: "typed"
            )

        self.assertEqual(entered, list(new_deployment.PROMPTED_PARAMETERS))
        stubber.assert_no_pending_responses()

    def test_skips_a_prompted_credential_left_blank(self):
        client, stubber = stubbed_client("ssm")
        self.add_listing(stubber, self.SOURCE, [])
        self.add_listing(stubber, self.TARGET, [])

        with stubber:
            _, entered, skipped = new_deployment.populate_parameters(
                StubbedSession({"ssm": client}), self.SOURCE, self.TARGET, lambda name: ""
            )

        self.assertEqual(entered, [])
        self.assertTrue(all("left blank" in note for note in skipped))
        stubber.assert_no_pending_responses()

    def test_does_not_ask_for_a_credential_already_set_on_the_target(self):
        client, stubber = stubbed_client("ssm")
        self.add_listing(stubber, self.SOURCE, [])
        self.add_listing(stubber, self.TARGET, [("ANTHROPIC_API_KEY", "SecureString")])
        self.add_write(stubber, "temporal-admin/API_KEY", "SecureString", "typed")

        with stubber:
            _, entered, skipped = new_deployment.populate_parameters(
                StubbedSession({"ssm": client}), self.SOURCE, self.TARGET, lambda name: "typed"
            )

        self.assertEqual(entered, ["temporal-admin/API_KEY"])
        self.assertIn("ANTHROPIC_API_KEY (already set on this deployment)", skipped)
        stubber.assert_no_pending_responses()

    def test_never_copies_the_terraform_managed_key(self):
        client, stubber = stubbed_client("ssm")
        self.add_listing(stubber, self.SOURCE, [("TEMPORAL_API_KEY", "SecureString")])
        self.add_listing(stubber, self.TARGET, [])
        self.add_write(stubber, "ANTHROPIC_API_KEY", "SecureString", "typed")
        self.add_write(stubber, "temporal-admin/API_KEY", "SecureString", "typed")

        with stubber:
            copied, _, skipped = new_deployment.populate_parameters(
                StubbedSession({"ssm": client}), self.SOURCE, self.TARGET, lambda name: "typed"
            )

        self.assertEqual(copied, [])
        self.assertIn("TEMPORAL_API_KEY (written by the temporal-workers stack)", skipped)
        stubber.assert_no_pending_responses()

    def test_leaves_a_copied_value_already_set_on_the_target_alone(self):
        """A bootstrap, not a sync: overwriting a rotated credential is the worse failure."""
        client, stubber = stubbed_client("ssm")
        self.add_listing(stubber, self.SOURCE, [("GITHUB_TOKEN", "SecureString")])
        self.add_listing(stubber, self.TARGET, [("GITHUB_TOKEN", "SecureString")])

        with stubber:
            copied, _, skipped = new_deployment.populate_parameters(
                StubbedSession({"ssm": client}), self.SOURCE, self.TARGET, lambda name: ""
            )

        self.assertEqual(copied, [])
        self.assertIn("GITHUB_TOKEN (already set on this deployment)", skipped)
        stubber.assert_no_pending_responses()

    def test_carries_a_plain_string_parameter_as_a_plain_string(self):
        """AGENT_USER_ID is not sensitive and is provisioned as String, not SecureString."""
        client, stubber = stubbed_client("ssm")
        self.add_listing(stubber, self.SOURCE, [("AGENT_USER_ID", "String")])
        self.add_listing(stubber, self.TARGET, [])
        self.add_read(stubber, "AGENT_USER_ID")
        self.add_write(stubber, "AGENT_USER_ID", "String", "value-of-AGENT_USER_ID")

        with stubber:
            copied, _, _ = new_deployment.populate_parameters(
                StubbedSession({"ssm": client}), self.SOURCE, self.TARGET, lambda name: ""
            )

        self.assertEqual(copied, ["AGENT_USER_ID"])
        stubber.assert_no_pending_responses()

    def test_reports_a_failed_write_as_an_operator_error(self):
        client, stubber = stubbed_client("ssm")
        self.add_listing(stubber, self.SOURCE, [("GITHUB_TOKEN", "SecureString")])
        self.add_listing(stubber, self.TARGET, [])
        self.add_read(stubber, "GITHUB_TOKEN")
        stubber.add_client_error("put_parameter", service_error_code="AccessDeniedException")

        with stubber, self.assertRaises(new_deployment.DeploymentError) as raised:
            new_deployment.populate_parameters(
                StubbedSession({"ssm": client}), self.SOURCE, self.TARGET, lambda name: ""
            )

        self.assertIn(f"{self.TARGET}GITHUB_TOKEN", str(raised.exception))


class ReadSecretTest(unittest.TestCase):
    """Windows' getpass ignores a pipe and reads the console, so a piped run used to hang."""

    def read_with_stdin(self, text, isatty):
        stdin = io.StringIO(text)
        stdin.isatty = lambda: isatty

        with unittest.mock.patch.object(sys, "stdin", stdin):
            with unittest.mock.patch("sys.stdout", io.StringIO()):
                return new_deployment.read_secret("ANTHROPIC_API_KEY")

    def test_reads_from_a_pipe_when_there_is_no_terminal(self):
        self.assertEqual(self.read_with_stdin("piped-value\n", isatty=False), "piped-value")

    def test_treats_an_empty_piped_line_as_blank(self):
        self.assertEqual(self.read_with_stdin("\n", isatty=False), "")

    def test_uses_getpass_at_a_terminal_so_the_value_is_not_echoed(self):
        with unittest.mock.patch.object(new_deployment, "getpass") as getpass_module:
            getpass_module.getpass.return_value = "  typed-value  "
            stdin = io.StringIO()
            stdin.isatty = lambda: True

            with unittest.mock.patch.object(sys, "stdin", stdin):
                value = new_deployment.read_secret("ANTHROPIC_API_KEY")

        self.assertEqual(value, "typed-value")
        getpass_module.getpass.assert_called_once()


class PromptedParametersTest(unittest.TestCase):
    def test_the_per_deployment_credentials_are_never_also_copied(self):
        self.assertEqual(
            set(new_deployment.PROMPTED_PARAMETERS) & set(new_deployment.TERRAFORM_MANAGED_PARAMETERS),
            set(),
        )

    def test_covers_the_credentials_issued_per_deployment(self):
        self.assertEqual(
            new_deployment.PROMPTED_PARAMETERS, ("ANTHROPIC_API_KEY", "temporal-admin/API_KEY")
        )


if __name__ == "__main__":
    unittest.main(verbosity=2, argv=[sys.argv[0]])

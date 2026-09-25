#!/usr/bin/env python3
"""Stand up a new deployment from an existing one: CDKTN config, state bucket, SSM parameters.

Usage: python3 scripts/new-deployment.py [TEAM_ID]

A deployment is one CDKTN context — `infrastructure/cdktf.<NAME>.json`, gitignored,
carrying one engagement's AWS account, state bucket, domain, SSM prefix and VPC.
Standing a new one up by hand is a file copy, a global find-and-replace, a
hand-picked VPC CIDR, an S3 bucket, and a handful of SSM parameters retyped out of
a password manager. All of that is mechanical except the CIDR, and the CIDR is the
one that fails quietly: two deployments on the same block only collide later, when
something tries to peer or route between them.

The deployment name is the tracker team id plus a two-digit month and day —
`PROJ0903` for team `PROJ` stood up on September 3rd. It appears in the config
uppercase (`output`, the `environment` tag, every `environment-name`) and lowercase
(`state-bucket-name`, `parameter-prefix`, `resource-name-prefix`,
`temporal.namespace-name`), so the rename preserves the case of each site rather
than substituting one spelling everywhere.

Everything else is inherited from the base config unchanged — deliberately, including
whatever has drifted between deployments. The base you pick is the shape you get.

Generating the config needs nothing installed, so it runs the same under Windows
Python and WSL. The AWS steps need `boto3`, and are each offered rather than assumed;
they use the profile and region from the config being created.

Not every credential is copied. The ones issued fresh per deployment are typed in
instead — see `PROMPTED_PARAMETERS` — and the old deployment's values for those are
never even decrypted. Whether copied or typed, a value exists only as a string in
memory between the read and the write: never to disk, never onto a command line where
another process on the machine could read it, and never echoed to the terminal.

This derives a deployment from an existing one. The first deployment in a fresh
checkout starts from `infrastructure/cdktf.example.json` by hand — see
`infrastructure/README.md`, "Configuration".
"""
import argparse
import getpass
import ipaddress
import json
import re
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INFRASTRUCTURE_DIRECTORY = REPO_ROOT / "infrastructure"

CONFIG_FILE_PATTERN = re.compile(r"^cdktf\.(?P<name>.+)\.json$")

# The committed template, not a deployment. Excluded as a base because its
# identity *is* the word "example" — renaming it would rewrite `example.com`,
# `example-org` and every other placeholder into the new deployment's name.
TEMPLATE_CONFIG_NAME = "example"

# Shape only, not length — length is the `environment-name` cap below, so there is
# one number to be wrong about rather than two that can disagree.
TEAM_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")
MONTH_DAY_PATTERN = re.compile(r"^(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$")

# `listener.environment-name` is documented as capped at 30: load balancer and
# target group names cap at 32 and the stacks suffix them.
ENVIRONMENT_NAME_MAX_LENGTH = 30

CIDR_PREFIX_LENGTH = 22
CIDR_SPACE = ipaddress.ip_network("10.0.0.0/8")
FIRST_CIDR_BLOCK = ipaddress.ip_network("10.0.0.0/22")

# Written into SSM by `temporal-workers.ts` itself, freshly generated per apply from
# the Temporal Cloud namespace's own Apikey resource. Copying the previous
# deployment's value would point the new deployment's workers at the old namespace
# until the first apply overwrote it — a failure that looks like a routing bug.
TERRAFORM_MANAGED_PARAMETERS = frozenset({"TEMPORAL_API_KEY"})

# Issued fresh per deployment, so these are asked for rather than read across from the
# deployment being copied. A shared credential quietly couples two deployments:
# revoking or rotating it for one breaks the other, and nothing in either one's logs
# says why. Ordered, because this is the order they are typed in.
PROMPTED_PARAMETERS = ("ANTHROPIC_API_KEY", "temporal-admin/API_KEY")


class DeploymentError(Exception):
    """A condition the operator has to resolve; reported without a traceback."""


# --- Naming -----------------------------------------------------------------


def deployment_name_from_path(path):
    """`cdktf.PROJ0903.json` -> `PROJ0903`; None for anything else, including `cdktf.json`."""
    match = CONFIG_FILE_PATTERN.match(Path(path).name)
    return match.group("name") if match else None


def build_deployment_name(team_id, month_day):
    """Tracker team id + MMDD, uppercase. The lowercase sites are derived at rename."""
    if not TEAM_ID_PATTERN.match(team_id):
        raise DeploymentError(
            f"Team id {team_id!r} must start with a letter and hold only letters and digits."
        )

    if not MONTH_DAY_PATTERN.match(month_day):
        raise DeploymentError(f"Date {month_day!r} must be MMDD, e.g. 0903.")

    name = f"{team_id.upper()}{month_day}"

    if len(name) > ENVIRONMENT_NAME_MAX_LENGTH:
        raise DeploymentError(
            f"Deployment name {name!r} is {len(name)} characters; "
            f"`environment-name` caps at {ENVIRONMENT_NAME_MAX_LENGTH}."
        )

    return name


def rename_deployment(value, old_name, new_name):
    """Replace `old_name` in a string, preserving the case of each site.

    The same name is spelled uppercase in `environment-name` and lowercase in
    `state-bucket-name` within one file, so a plain replace gets one of them wrong
    and a lowercasing replace gets the other. Matching case-insensitively and
    echoing back the case actually found covers both without enumerating which key
    is which.
    """

    def substitute(match):
        matched = match.group(0)

        if matched.isupper():
            return new_name.upper()

        if matched.islower():
            return new_name.lower()

        return new_name

    return re.sub(re.escape(old_name), substitute, value, flags=re.IGNORECASE)


def rename_deployment_in_config(config, old_name, new_name):
    """Rename every string *value* in the config, returning the new config and a count.

    Values only: the one place this config uses data as a key is the reviewer table,
    whose keys are email addresses, and an address that happened to contain a team id
    is not a rename site.
    """
    renamed_sites = 0

    def walk(node):
        nonlocal renamed_sites

        if isinstance(node, dict):
            return {key: walk(child) for key, child in node.items()}

        if isinstance(node, list):
            return [walk(child) for child in node]

        if isinstance(node, str):
            renamed = rename_deployment(node, old_name, new_name)
            if renamed != node:
                renamed_sites += 1
            return renamed

        return node

    return walk(config), renamed_sites


def validate_generated_config(config, old_name, new_name):
    """Every invariant a hand-done find-and-replace has historically got wrong.

    Returns a list of problems; empty means the config is safe to write. Checked
    before the file lands rather than after, so a base that renames badly is a
    refusal rather than a config that synths against the wrong bucket.
    """
    problems = []
    context = config.get("context", {})
    lowercase_name = new_name.lower()

    def check_contains(label, value, expected):
        if not isinstance(value, str):
            problems.append(f"{label} is missing or not a string")
        elif expected not in value:
            problems.append(f"{label} is {value!r}, which does not contain {expected!r}")

    if config.get("output") != f"{new_name}.out":
        problems.append(f"output is {config.get('output')!r}, expected {new_name + '.out'!r}")

    check_contains(
        "global-tags.environment", context.get("global-tags", {}).get("environment"), new_name
    )
    check_contains("state-bucket-name", context.get("state-bucket-name"), lowercase_name)
    check_contains("parameter-prefix", context.get("parameter-prefix"), lowercase_name)
    check_contains("resource-name-prefix", context.get("resource-name-prefix"), lowercase_name)

    for stack in ("listener", "specialist-sandbox", "temporal"):
        check_contains(
            f"{stack}.environment-name", context.get(stack, {}).get("environment-name"), new_name
        )

    check_contains(
        "temporal.namespace-name", context.get("temporal", {}).get("namespace-name"), lowercase_name
    )

    environment_name = context.get("listener", {}).get("environment-name")
    if isinstance(environment_name, str) and len(environment_name) > ENVIRONMENT_NAME_MAX_LENGTH:
        problems.append(
            f"listener.environment-name is {len(environment_name)} characters, "
            f"over the {ENVIRONMENT_NAME_MAX_LENGTH} cap"
        )

    if re.search(re.escape(old_name), json.dumps(config), flags=re.IGNORECASE):
        problems.append(f"the base deployment name {old_name!r} still appears in the result")

    return problems


# --- VPC CIDR ---------------------------------------------------------------


def used_cidr_blocks(config_paths):
    """Every `vpc-cidr-block` already spoken for, across all local configs.

    Unparseable or absent values are skipped rather than fatal: a half-written
    config beside the one being copied should not stop a new deployment.
    """
    blocks = set()

    for path in config_paths:
        try:
            context = json.loads(Path(path).read_text(encoding="utf-8")).get("context", {})
            blocks.add(ipaddress.IPv4Network(context["vpc-cidr-block"], strict=True))
        except (OSError, ValueError, KeyError, AttributeError, TypeError):
            continue

    return sorted(blocks)


def next_free_cidr_block(used_blocks):
    """The next block in the shape the deployments already use: `10.<n>.0.0/22`.

    One second octet per deployment, three quarters of each one deliberately left
    unused. Packing tightly instead — the very next aligned /22, `10.13.4.0/22`
    after `10.13.0.0/22` — would fit far more deployments into 10/8 than will ever
    exist, at the cost of a block whose number no longer reads as one deployment's.

    Moving above the highest rather than filling a gap: a torn-down deployment's
    config file is routinely deleted while a peering, a route, or a security group
    rule elsewhere still names its block, so a new deployment never inherits an old
    one's address space.
    """
    # A block outside 10/8 still counts against the operator's own choice below, but
    # it must not drag the suggestion out of the range these VPCs live in.
    within_space = [block for block in used_blocks if block.subnet_of(CIDR_SPACE)]

    if not within_space:
        return FIRST_CIDR_BLOCK

    highest_octet = max(block.network_address.packed[1] for block in within_space)

    if highest_octet >= 255:
        raise DeploymentError(
            f"No second octet left in {CIDR_SPACE} after 10.{highest_octet}.x; "
            "pick a range by hand."
        )

    return ipaddress.IPv4Network(f"10.{highest_octet + 1}.0.0/{CIDR_PREFIX_LENGTH}")


def parse_cidr_choice(value, used_blocks):
    """Validate an operator-supplied CIDR, refusing overlap with a deployment already on it."""
    try:
        block = ipaddress.IPv4Network(value, strict=True)
    except ValueError as error:
        raise DeploymentError(f"{value!r} is not a valid network address: {error}") from error

    if block.prefixlen != CIDR_PREFIX_LENGTH:
        raise DeploymentError(
            f"{value} is a /{block.prefixlen}; the stacks split the VPC into /24 subnets "
            f"and expect a /{CIDR_PREFIX_LENGTH}."
        )

    for used in used_blocks:
        if block.overlaps(used):
            raise DeploymentError(
                f"{value} overlaps {used}, which another local config already uses."
            )

    return block


# --- AWS --------------------------------------------------------------------


def load_boto3():
    """Import boto3, or None if it is not installed.

    Attempted once at startup rather than at the AWS steps themselves, so a missing
    install is reported before any question has been asked rather than after a config
    has been written. Kept out of the module's own imports so that generating a config
    needs nothing installed, and so that the test suite — which exercises the pure
    functions above — stays dependency-free.
    """
    try:
        import boto3
    except ImportError:
        return None

    return boto3


def build_session(boto3, profile, region):
    """A session on the profile the config names, never the default one."""
    from botocore.exceptions import ProfileNotFound

    try:
        return boto3.Session(profile_name=profile, region_name=region)
    except ProfileNotFound as error:
        raise DeploymentError(
            f"AWS profile {profile!r}, from the config's `aws.profile`, is not configured "
            "on this machine."
        ) from error


def verify_account(session, expected_account_number):
    """Refuse to touch any account other than the one the config names.

    The stacks hand `aws.account-number` to Terraform as `allowed_account_ids`, so a
    mis-set profile fails the plan instead of applying somewhere else. The two steps
    below run before Terraform ever does, and one of them writes credentials, so they
    need that guard rather than inheriting it. Creating a bucket in the wrong account
    is recoverable; seeding another account's parameter store with this one's secrets
    is not.
    """
    from botocore.exceptions import BotoCoreError, ClientError

    if not expected_account_number:
        raise DeploymentError("The config has no `aws.account-number` to check the profile against.")

    try:
        account_number = session.client("sts").get_caller_identity()["Account"]
    except (BotoCoreError, ClientError) as error:
        raise DeploymentError(f"Could not resolve the profile's own identity: {error}") from error

    if account_number != str(expected_account_number):
        raise DeploymentError(
            f"The configured profile resolves to account {account_number}, but the config's "
            f"`aws.account-number` is {expected_account_number}. Refusing to create a bucket "
            "or write parameters in an account this deployment does not name."
        )

    return account_number


def create_state_bucket(session, bucket_name, region):
    """Create the Terraform state bucket, versioned and closed to the public.

    Out of band by necessity: the bucket cannot live in the state it holds. Versioning
    is the documented requirement — it is what makes a corrupted or truncated state
    file recoverable. Default encryption is not set here because S3 has applied SSE-S3
    to new buckets by default since January 2023.
    """
    from botocore.exceptions import ClientError

    s3 = session.client("s3")

    try:
        s3.head_bucket(Bucket=bucket_name)
        return f"{bucket_name} already exists; leaving it alone"
    except ClientError as error:
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")

        # Bucket names are global, so 403 is someone else's bucket rather than a
        # permissions problem with your own. Said plainly here; `create_bucket` would
        # otherwise report it several calls later as an ownership conflict.
        if status == 403:
            raise DeploymentError(
                f"{bucket_name} already exists and is not yours. S3 bucket names are "
                "global, so this deployment needs a different `state-bucket-name`."
            ) from error

        if status != 404:
            raise DeploymentError(f"Checking for {bucket_name} failed: {error}") from error

    create_arguments = {"Bucket": bucket_name}

    # us-east-1 is the API's default and the only region that rejects being named
    # explicitly in a LocationConstraint.
    if region != "us-east-1":
        create_arguments["CreateBucketConfiguration"] = {"LocationConstraint": region}

    try:
        s3.create_bucket(**create_arguments)
        s3.put_bucket_versioning(
            Bucket=bucket_name, VersioningConfiguration={"Status": "Enabled"}
        )
        s3.put_public_access_block(
            Bucket=bucket_name,
            PublicAccessBlockConfiguration={
                "BlockPublicAcls": True,
                "IgnorePublicAcls": True,
                "BlockPublicPolicy": True,
                "RestrictPublicBuckets": True,
            },
        )
    except ClientError as error:
        raise DeploymentError(f"Creating {bucket_name} failed: {error}") from error

    return f"created {bucket_name}, versioned and public access blocked"


def fetch_parameters(session, prefix, with_decryption):
    """Every parameter under a prefix, following the paginator to the end."""
    from botocore.exceptions import ClientError

    pages = session.client("ssm").get_paginator("get_parameters_by_path")
    parameters = []

    try:
        for page in pages.paginate(Path=prefix, Recursive=True, WithDecryption=with_decryption):
            parameters.extend(page["Parameters"])
    except ClientError as error:
        raise DeploymentError(f"Reading parameters under {prefix} failed: {error}") from error

    return parameters


def populate_parameters(session, source_prefix, target_prefix, read_secret):
    """Fill a new deployment's SSM prefix: some copied across, some typed in.

    The set that is copied is read back from the source rather than enumerated from a
    hardcoded list, so a parameter added to a deployment later comes along without this
    script being edited — the naming pattern under the prefix is the contract, not any
    particular set of names. `PROMPTED_PARAMETERS` is the exception, and is enumerated
    precisely because it is a policy about which credentials may be shared.

    Nothing already set at the target is touched: this is a bootstrap, not a sync, and
    silently overwriting a credential someone had rotated is the worse failure. A value
    only exists as a Python string between the read and the write — never in a file,
    never on a command line, which is why this talks to the API directly.

    Returns (copied, entered, skipped), each a list of names relative to the prefix.
    """
    from botocore.exceptions import ClientError

    ssm = session.client("ssm")

    # Names and types first, undecrypted. What gets decrypted below is then only what is
    # actually being copied, so a prompted credential's old value is never even read.
    source_parameters = fetch_parameters(session, source_prefix, with_decryption=False)
    existing = fetch_parameters(session, target_prefix, with_decryption=False)
    existing_names = {parameter["Name"] for parameter in existing}
    source_types = {
        parameter["Name"][len(source_prefix) :]: parameter["Type"]
        for parameter in source_parameters
    }

    copied, entered, skipped = [], [], []

    def write(relative_name, parameter_type, value):
        target_name = f"{target_prefix}{relative_name}"

        try:
            ssm.put_parameter(Name=target_name, Type=parameter_type, Value=value)
        except ClientError as error:
            raise DeploymentError(f"Writing {target_name} failed: {error}") from error

    # Asked for up front, so all the typing happens together rather than interleaved
    # with API calls. SecureString unless the source says otherwise: a prompted value
    # is a credential, and a name absent from the source has no type to inherit.
    for relative_name in PROMPTED_PARAMETERS:
        if f"{target_prefix}{relative_name}" in existing_names:
            skipped.append(f"{relative_name} (already set on this deployment)")
            continue

        value = read_secret(relative_name)

        if not value:
            skipped.append(f"{relative_name} (left blank, set it before deploying)")
            continue

        write(relative_name, source_types.get(relative_name, "SecureString"), value)
        entered.append(relative_name)

    for parameter in source_parameters:
        relative_name = parameter["Name"][len(source_prefix) :]

        if relative_name in PROMPTED_PARAMETERS:
            continue

        if relative_name in TERRAFORM_MANAGED_PARAMETERS:
            skipped.append(f"{relative_name} (written by the temporal-workers stack)")
            continue

        if f"{target_prefix}{relative_name}" in existing_names:
            skipped.append(f"{relative_name} (already set on this deployment)")
            continue

        try:
            value = ssm.get_parameter(Name=parameter["Name"], WithDecryption=True)
        except ClientError as error:
            raise DeploymentError(f"Reading {parameter['Name']} failed: {error}") from error

        write(relative_name, parameter["Type"], value["Parameter"]["Value"])
        copied.append(relative_name)

    return copied, entered, skipped


# --- Prompts ----------------------------------------------------------------


def ask(question, default=None):
    suffix = f" [{default}]" if default is not None else ""

    while True:
        answer = input(f"{question}{suffix}: ").strip()

        if answer:
            return answer

        if default is not None:
            return default


def read_secret(name):
    """Read one credential without echoing it, at a terminal or from a pipe.

    The terminal check is this function's own rather than left to `getpass`, because
    `getpass` is not consistent across the two platforms this runs on. On POSIX it
    notices there is no terminal, warns, and reads stdin. On Windows it reads the
    console directly through `msvcrt` whatever stdin is, so a piped run blocks forever
    on input that was already waiting in the pipe — confirmed 2026-09-18, a piped run
    hung with no output and had to be killed. Deciding here makes both behave the same.
    """
    prompt = f"  {name}: "

    if not sys.stdin.isatty():
        print(prompt, end="", flush=True)
        return sys.stdin.readline().strip()

    return getpass.getpass(prompt).strip()


def confirm(question, default=False):
    hint = "Y/n" if default else "y/N"
    answer = input(f"{question} [{hint}]: ").strip().lower()

    if not answer:
        return default

    return answer in ("y", "yes")


def choose_base_config(config_paths):
    print("Base this deployment on:\n")

    for index, path in enumerate(config_paths, start=1):
        print(f"  {index}. {path.name}")

    print()

    while True:
        choice = ask("Number", default="1")

        try:
            return config_paths[int(choice) - 1]
        except (ValueError, IndexError):
            print(f"  Pick a number between 1 and {len(config_paths)}.")


# --- Entry point ------------------------------------------------------------


def parse_arguments(argv=None):
    """The team id is the one input with no sensible default, so it is the one argument.

    Every other question either defaults to something you can accept with Enter (today's
    date, the next free CIDR, the most recent base config) or is a yes/no. The team id is
    known before the script starts and cannot be guessed, so passing it saves the one
    keystroke sequence that is never optional.
    """
    parser = argparse.ArgumentParser(
        prog="new-deployment.py",
        description=(
            "Stand up a new deployment from an existing one: CDKTN config, state bucket, "
            "SSM parameters."
        ),
    )
    parser.add_argument(
        "team_id",
        nargs="?",
        help=(
            "Tracker team id, e.g. PROJ. The deployment name is this plus MMDD. "
            "Prompted for when omitted."
        ),
    )

    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    boto3 = load_boto3()

    if boto3 is None:
        print("boto3 is not installed, so the bucket and parameter steps will be skipped.")
        print("The config will still be written. Install it with: pip install boto3\n")

    all_config_paths = sorted(
        path
        for path in INFRASTRUCTURE_DIRECTORY.glob("cdktf.*.json")
        if deployment_name_from_path(path) is not None
    )
    base_candidates = [
        path
        for path in all_config_paths
        if deployment_name_from_path(path) != TEMPLATE_CONFIG_NAME
    ]

    if not base_candidates:
        raise DeploymentError(
            f"No deployment config to copy in {INFRASTRUCTURE_DIRECTORY}.\n"
            "The first one starts from cdktf.example.json by hand: see "
            'infrastructure/README.md, "Configuration".'
        )

    base_path = choose_base_config(base_candidates)
    base_name = deployment_name_from_path(base_path)
    base_config = json.loads(base_path.read_text(encoding="utf-8"))

    print()
    new_name = build_deployment_name(
        arguments.team_id or ask("Tracker team id"),
        ask("Month and day (MMDD)", default=date.today().strftime("%m%d")),
    )

    if new_name.lower() == base_name.lower():
        raise DeploymentError(f"{new_name} is the base deployment; nothing to create.")

    target_path = INFRASTRUCTURE_DIRECTORY / f"cdktf.{new_name}.json"

    if target_path.exists():
        raise DeploymentError(f"{target_path.name} already exists.")

    used_blocks = used_cidr_blocks(all_config_paths)
    in_use = ", ".join(str(block) for block in used_blocks) or "none"

    print(f"\nVPC CIDRs already in use: {in_use}")
    cidr_block = parse_cidr_choice(
        ask("VPC CIDR", default=str(next_free_cidr_block(used_blocks))), used_blocks
    )

    new_config, renamed_sites = rename_deployment_in_config(base_config, base_name, new_name)
    new_config["context"]["vpc-cidr-block"] = str(cidr_block)

    problems = validate_generated_config(new_config, base_name, new_name)

    if problems:
        raise DeploymentError(
            f"{base_path.name} does not rename cleanly into {new_name}:\n  - "
            + "\n  - ".join(problems)
        )

    # LF regardless of platform: the project is applied from WSL.
    with open(target_path, "w", encoding="utf-8", newline="\n") as config_file:
        config_file.write(json.dumps(new_config, indent=2) + "\n")

    print(f"\nWrote {target_path.name} ({renamed_sites} values renamed from {base_name}).")

    if boto3 is not None:
        context = new_config["context"]
        region = context["aws"]["region"]
        bucket_name = context["state-bucket-name"]
        source_prefix = base_config["context"]["parameter-prefix"]
        target_prefix = context["parameter-prefix"]
        profile = context["aws"]["profile"]

        session = build_session(boto3, profile, region)
        account_number = verify_account(session, context["aws"]["account-number"])
        print(f"\nProfile {profile} resolves to account {account_number}, as configured.")

        print()
        if confirm(f"Create the Terraform state bucket {bucket_name}?", default=True):
            print(f"  {create_state_bucket(session, bucket_name, region)}")

        print()
        print(f"SSM parameters under {target_prefix}: everything under {source_prefix}")
        print(f"is copied across except {', '.join(PROMPTED_PARAMETERS)}, which are issued")
        print("per deployment and so are asked for instead.")

        if confirm("Set them up now?", default=True):
            copied, entered, skipped = populate_parameters(
                session, source_prefix, target_prefix, read_secret
            )

            for name in entered:
                print(f"  set {name} from the value you entered")

            for name in copied:
                print(f"  copied {name}")

            for note in skipped:
                print(f"  skipped {note}")

            if not copied and not entered and not skipped:
                print(f"  nothing found under {source_prefix}")

    print_next_steps(new_name, new_config, boto3 is not None)


def print_next_steps(new_name, config, aws_steps_ran):
    # Printed text stays ASCII. A Windows console still defaults to a legacy code
    # page, where an em dash from this file's prose style arrives as a replacement
    # character in the middle of instructions someone is about to follow.
    print("\nNext, from infrastructure/. cdktn only ever reads `cdktf.json`, so the")
    print("config has to stand in under that name for the run and move back after:\n")
    print(f"  mv cdktf.{new_name}.json cdktf.json")
    print("  npx cdktn get && npm run synth && npm run diff")
    print(f"  mv cdktf.json cdktf.{new_name}.json\n")

    if not aws_steps_ran:
        context = config["context"]
        print(f"Still to do by hand: create the state bucket {context['state-bucket-name']} and")
        print(f"populate the SSM parameters under {context['parameter-prefix']}.")
        print("See infrastructure/README.md.")

    print("Carried over from the base and worth a look before applying: each stack's")
    print("`image-tag`, and `temporal.reviewer-email-to-github-login`.")


if __name__ == "__main__":
    try:
        main()
    except DeploymentError as error:
        print(f"\n{error}", file=sys.stderr)
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.", file=sys.stderr)
        sys.exit(130)

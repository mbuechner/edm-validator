"""Resolve the tagged Dockerfile's bases and check the published image."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


BUILD_INPUTS_LABEL = "de.ddb.edm-validator.build-inputs"
TAGGED_IMAGE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9./_-]*:[a-zA-Z0-9_.-]+")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def inspect(image, field, *, allow_missing=False):
    result = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", "--format", field, image],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode == 0:
        return json.loads(result.stdout)

    error = result.stderr.strip()
    if allow_missing and (
        f"{image.lower()}: not found" in error.lower()
        or "manifest unknown" in error.lower()
    ):
        return None
    raise SystemExit(error or f"Could not inspect {image}.")


def base_images(dockerfile):
    images = []
    for line in dockerfile.read_text(encoding="utf-8-sig").splitlines():
        fields = line.split()
        if fields and fields[0].upper() == "FROM":
            if len(fields) < 2 or not TAGGED_IMAGE.fullmatch(fields[1]):
                raise SystemExit(f"Expected a literal tagged base image: {line}")
            images.append(fields[1])
    if not images:
        raise SystemExit(f"No base image found in {dockerfile}.")
    return images


def platform_manifest(manifest, os_name, arch):
    if "manifests" not in manifest:
        return manifest
    for entry in manifest["manifests"]:
        platform = entry.get("platform", {})
        if (platform.get("os"), platform.get("architecture")) == (os_name, arch):
            return entry
    return None


def digest_of(manifest):
    digest = manifest.get("digest", "")
    if not DIGEST.fullmatch(digest):
        raise SystemExit(f"Invalid registry digest: {digest!r}")
    return digest


def image_config(image, digest):
    return inspect(f"{image.split('@', 1)[0]}@{digest}", "{{json .Image}}")


def base_digest(image, os_name, arch):
    manifest = inspect(image, "{{json .Manifest}}")
    descriptor = platform_manifest(manifest, os_name, arch)
    if descriptor is not None:
        digest = digest_of(descriptor)
        if descriptor is not manifest:
            return digest
        config = image_config(image, digest)
        if (config.get("os"), config.get("architecture")) == (os_name, arch):
            return digest
    raise SystemExit(f"No {os_name}/{arch} digest found for {image}.")


def reusable_digest(image, fingerprint, os_name, arch):
    manifest = inspect(image, "{{json .Manifest}}", allow_missing=True)
    if manifest is None:
        return None
    descriptor = platform_manifest(manifest, os_name, arch)
    if descriptor is None:
        return None
    digest = digest_of(descriptor)
    config = image_config(image, digest)
    if (config.get("os"), config.get("architecture")) != (os_name, arch):
        return None
    labels = (config.get("config") or {}).get("Labels") or {}
    if labels.get(BUILD_INPUTS_LABEL) == fingerprint:
        return digest
    return None


def main():
    platform = os.environ["PLATFORM"]
    os_name, arch = platform.split("/")
    names = base_images(Path("release-source/Dockerfile"))
    bases = {name: base_digest(name, os_name, arch) for name in dict.fromkeys(names)}
    source = os.environ["RELEASE_REVISION"]
    fingerprint = hashlib.sha256(json.dumps([source, platform, bases], sort_keys=True).encode()).hexdigest()
    release_image = f"{os.environ['IMAGE']}:{os.environ['RELEASE_TAG']}"
    digest = reusable_digest(release_image, fingerprint, os_name, arch)

    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        if digest:
            print(f"reusable_digest={digest}", file=output)
            print(f"Reusing {release_image}@{digest} with unchanged build inputs.")
            return

        runtime = names[-1]
        print(f"base_name={runtime}", file=output)
        print(f"base_digest={bases[runtime]}", file=output)
        print(f"fingerprint={fingerprint}", file=output)
        print("contexts<<BASE_IMAGES", file=output)
        for name, digest in bases.items():
            print(f"{name}=docker-image://{name}@{digest}", file=output)
        print("BASE_IMAGES", file=output)


if __name__ == "__main__":
    main()

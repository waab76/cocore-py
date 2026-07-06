from __future__ import annotations

from cocore_provider.provider_record import build_provider_record


def test_build_provider_record_required_fields() -> None:
    record = build_provider_record(
        machine_label="win-box",
        chip="lmstudio:windows",
        ram_gb=32,
        supported_models=["llama-3.1-8b", "qwen2.5-coder"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
    )
    assert record["machineLabel"] == "win-box"
    assert record["chip"] == "lmstudio:windows"
    assert record["ramGB"] == 32
    assert record["supportedModels"] == ["llama-3.1-8b", "qwen2.5-coder"]
    assert record["encryptionPubKey"] == "epk=="
    assert record["attestationPubKey"] == "apk=="
    assert record["trustLevel"] == "self-attested"
    assert record["binaryVersion"] == "0.1.0"
    assert isinstance(record["createdAt"], str)
    price_list = record["priceList"]
    assert isinstance(price_list, list)
    assert [p["modelId"] for p in price_list] == ["llama-3.1-8b", "qwen2.5-coder"]
    assert all(p["currency"] == "CC" for p in price_list)


def test_build_provider_record_ram_floor() -> None:
    # Lexicon requires ramGB >= 1; a 0/unreadable psutil reading must not
    # produce an invalid record.
    record = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=0,
        supported_models=["m1"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
    )
    assert record["ramGB"] == 1

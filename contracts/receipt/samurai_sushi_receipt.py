import hashlib
import json
from pathlib import Path

import smartpy as sp


ROOT = Path(__file__).resolve().parents[2]
AUTHORITY_MANIFEST = json.loads(
    (ROOT / "contracts/receipt/authority-manifest.json").read_text(encoding="utf-8")
)
GOLDEN_VECTOR = json.loads(
    (
        ROOT
        / "packages/receipt-authority/fixtures/receipt-permit-v1.json"
    ).read_text(encoding="utf-8")
)
AUTHORITY_CANONICAL = json.dumps(
    AUTHORITY_MANIFEST, ensure_ascii=False, separators=(",", ":"), sort_keys=True
).encode("utf-8")
AUTHORITY_MANIFEST_HASH = hashlib.sha256(AUTHORITY_CANONICAL).hexdigest()

DOMAIN = "SAMURAI_SUSHI_RECEIPT_V1"
ENTRYPOINT = "submit_receipt"
SCHEMA_VERSION = 1
FIXTURE_ISSUER_SECRET_KEY = sp.secret_key(
    "edsk2gM2LioC6YfkHSgkD1opuvCLS8Ao7ytPf4QXmaupPwVgF27wFW"
)


@sp.module
def receipt_v1():
    payload_type: type = sp.record(
        domain=sp.string,
        schema_version=sp.nat,
        chain_id=sp.chain_id,
        owner=sp.address,
        source=sp.address,
        destination=sp.address,
        entrypoint=sp.string,
        attached_mutez=sp.mutez,
        service_commitment=sp.bytes,
        content_version=sp.string,
        nonce=sp.bytes,
        issued_at=sp.timestamp,
        expiry=sp.timestamp,
        deployment_manifest_hash=sp.bytes,
        issuer_key_id=sp.string,
        issuer_policy_version=sp.nat,
    ).layout(
        (
            "domain",
            (
                "schema_version",
                (
                    "chain_id",
                    (
                        "owner",
                        (
                            "source",
                            (
                                "destination",
                                (
                                    "entrypoint",
                                    (
                                        "attached_mutez",
                                        (
                                            "service_commitment",
                                            (
                                                "content_version",
                                                (
                                                    "nonce",
                                                    (
                                                        "issued_at",
                                                        (
                                                            "expiry",
                                                            (
                                                                "deployment_manifest_hash",
                                                                (
                                                                    "issuer_key_id",
                                                                    "issuer_policy_version",
                                                                ),
                                                            ),
                                                        ),
                                                    ),
                                                ),
                                            ),
                                        ),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
    )
    permit_type: type = sp.record(
        payload=payload_type,
        payload_hash=sp.bytes,
        signature=sp.signature,
    ).layout(("payload", ("payload_hash", "signature")))
    issuer_policy_type: type = sp.record(
        policy_version=sp.nat,
        public_key=sp.key,
        activates_at=sp.timestamp,
        retires_at=sp.timestamp,
        verify_until=sp.timestamp,
        revoked=sp.bool,
    ).layout(
        (
            "policy_version",
            (
                "public_key",
                ("activates_at", ("retires_at", ("verify_until", "revoked"))),
            ),
        )
    )
    public_receipt_type: type = sp.record(
        owner=sp.address,
        service_commitment=sp.bytes,
        content_version=sp.string,
        nonce=sp.bytes,
        payload_hash=sp.bytes,
        deployment_manifest_hash=sp.bytes,
        issuer_key_id=sp.string,
        issuer_policy_version=sp.nat,
        issued_at=sp.timestamp,
        expiry=sp.timestamp,
    ).layout(
        (
            "owner",
            (
                "service_commitment",
                (
                    "content_version",
                    (
                        "nonce",
                        (
                            "payload_hash",
                            (
                                "deployment_manifest_hash",
                                (
                                    "issuer_key_id",
                                    (
                                        "issuer_policy_version",
                                        ("issued_at", "expiry"),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
    )
    service_receipt_event_type: type = sp.record(
        owner=sp.address,
        service_commitment=sp.bytes,
        content_version=sp.string,
        nonce=sp.bytes,
        payload_hash=sp.bytes,
    ).layout(
        (
            "owner",
            (
                "service_commitment",
                ("content_version", ("nonce", "payload_hash")),
            ),
        )
    )

    class ReceiptAuthority(sp.Contract):
        def __init__(
            self,
            administrator,
            pause_controller,
            chain_id,
            content_version,
            deployment_manifest_hash,
            issuer_policies,
            maximum_permit_lifetime_seconds,
            max_clock_skew_seconds,
        ):
            self.data.administrator = administrator
            self.data.pause_controller = pause_controller
            self.data.paused = False
            self.data.chain_id = chain_id
            self.data.content_version = content_version
            self.data.deployment_manifest_hash = deployment_manifest_hash
            self.data.maximum_permit_lifetime_seconds = maximum_permit_lifetime_seconds
            self.data.max_clock_skew_seconds = max_clock_skew_seconds
            self.data.issuer_policies = sp.cast(
                issuer_policies, sp.big_map[sp.string, issuer_policy_type]
            )
            self.data.receipts = sp.cast(
                sp.big_map(), sp.big_map[sp.bytes, public_receipt_type]
            )
            self.data.used_nonces = sp.cast(
                sp.big_map(), sp.big_map[sp.bytes, sp.unit]
            )
            self.data.used_owner_commitments = sp.cast(
                sp.big_map(), sp.big_map[sp.pair[sp.address, sp.bytes], sp.unit]
            )

        @sp.entrypoint
        def submit_receipt(self, permit):
            sp.cast(permit, permit_type)
            payload = permit.payload
            assert sp.amount == sp.mutez(0), "RECEIPT_NONZERO_MUTEZ"
            assert not self.data.paused, "RECEIPT_PAUSED"
            assert payload.domain == "SAMURAI_SUSHI_RECEIPT_V1", "RECEIPT_DOMAIN"
            assert payload.schema_version == 1, "RECEIPT_SCHEMA"
            assert payload.chain_id == sp.chain_id, "RECEIPT_CHAIN"
            assert payload.chain_id == self.data.chain_id, "RECEIPT_PINNED_CHAIN"
            assert payload.owner == sp.sender, "RECEIPT_OWNER"
            assert payload.source == sp.sender, "RECEIPT_SOURCE"
            assert payload.owner == payload.source, "RECEIPT_OWNER_SOURCE"
            assert payload.destination == sp.self_address, "RECEIPT_DESTINATION"
            assert payload.entrypoint == "submit_receipt", "RECEIPT_ENTRYPOINT"
            assert payload.attached_mutez == sp.mutez(0), "RECEIPT_PAYLOAD_MUTEZ"
            assert (
                payload.content_version == self.data.content_version
            ), "RECEIPT_CONTENT_VERSION"
            assert (
                payload.deployment_manifest_hash
                == self.data.deployment_manifest_hash
            ), "RECEIPT_MANIFEST"
            assert payload.issuer_key_id in self.data.issuer_policies, "RECEIPT_ISSUER_KEY"
            policy = self.data.issuer_policies[payload.issuer_key_id]
            assert (
                policy.policy_version == payload.issuer_policy_version
            ), "RECEIPT_ISSUER_POLICY"
            assert not policy.revoked, "RECEIPT_ISSUER_REVOKED"
            assert policy.activates_at <= payload.issued_at, "RECEIPT_NOT_ACTIVE"
            assert payload.issued_at < policy.retires_at, "RECEIPT_RETIRED"
            assert payload.issued_at <= sp.add_seconds(
                sp.now, self.data.max_clock_skew_seconds
            ), "RECEIPT_CLOCK_SKEW"
            assert payload.issued_at < payload.expiry, "RECEIPT_DURATION"
            assert sp.as_nat(payload.expiry - payload.issued_at) <= (
                self.data.maximum_permit_lifetime_seconds
            ), "RECEIPT_LIFETIME"
            assert sp.now < payload.expiry, "RECEIPT_EXPIRED"
            assert sp.now < policy.verify_until, "RECEIPT_VERIFY_UNTIL"
            computed_hash = sp.blake2b(sp.pack(payload))
            assert computed_hash == permit.payload_hash, "RECEIPT_PAYLOAD_HASH"
            assert sp.check_signature(
                policy.public_key, permit.signature, computed_hash
            ), "RECEIPT_SIGNATURE"
            assert not (payload.nonce in self.data.used_nonces), "RECEIPT_NONCE_USED"
            uniqueness_key = (payload.owner, payload.service_commitment)
            assert not (
                uniqueness_key in self.data.used_owner_commitments
            ), "RECEIPT_COMMITMENT_USED"

            public_receipt = sp.record(
                owner=payload.owner,
                service_commitment=payload.service_commitment,
                content_version=payload.content_version,
                nonce=payload.nonce,
                payload_hash=computed_hash,
                deployment_manifest_hash=payload.deployment_manifest_hash,
                issuer_key_id=payload.issuer_key_id,
                issuer_policy_version=payload.issuer_policy_version,
                issued_at=payload.issued_at,
                expiry=payload.expiry,
            )
            sp.cast(public_receipt, public_receipt_type)
            self.data.receipts[computed_hash] = public_receipt
            self.data.used_nonces[payload.nonce] = ()
            self.data.used_owner_commitments[uniqueness_key] = ()
            event = sp.record(
                owner=payload.owner,
                service_commitment=payload.service_commitment,
                content_version=payload.content_version,
                nonce=payload.nonce,
                payload_hash=computed_hash,
            )
            sp.cast(event, service_receipt_event_type)
            sp.emit(event, tag="service_receipt", with_type=True)

        @sp.entrypoint
        def set_paused(self, paused):
            sp.cast(paused, sp.bool)
            assert sp.amount == sp.mutez(0), "RECEIPT_NONZERO_MUTEZ"
            assert sp.sender == self.data.pause_controller, "RECEIPT_NOT_PAUSE_CONTROLLER"
            self.data.paused = paused

        @sp.entrypoint
        def revoke_issuer(self, issuer_key_id):
            sp.cast(issuer_key_id, sp.string)
            assert sp.amount == sp.mutez(0), "RECEIPT_NONZERO_MUTEZ"
            assert sp.sender == self.data.administrator, "RECEIPT_NOT_ADMINISTRATOR"
            assert issuer_key_id in self.data.issuer_policies, "RECEIPT_ISSUER_KEY"
            self.data.issuer_policies[issuer_key_id].revoked = True


def authority_policy():
    policy = AUTHORITY_MANIFEST["issuerPolicies"][0]
    return sp.record(
        policy_version=sp.nat(int(policy["policyVersion"])),
        public_key=sp.key(policy["publicKey"]),
        activates_at=sp.timestamp(int(policy["activatesAt"])),
        retires_at=sp.timestamp(int(policy["retiresAt"])),
        verify_until=sp.timestamp(int(policy["verifyUntil"])),
        revoked=bool(policy["revoked"]),
    )


def receipt_contract():
    policy = AUTHORITY_MANIFEST["issuerPolicies"][0]
    return receipt_v1.ReceiptAuthority(
        administrator=sp.address(AUTHORITY_MANIFEST["sourceAdministrator"]),
        pause_controller=sp.address(AUTHORITY_MANIFEST["pauseController"]),
        chain_id=sp.chain_id_cst("0xd3166e11"),
        content_version=AUTHORITY_MANIFEST["contentVersion"],
        deployment_manifest_hash=sp.bytes("0x" + AUTHORITY_MANIFEST_HASH),
        issuer_policies=sp.big_map({policy["keyId"]: authority_policy()}),
        maximum_permit_lifetime_seconds=sp.nat(
            AUTHORITY_MANIFEST["maximumPermitLifetimeSeconds"]
        ),
        max_clock_skew_seconds=sp.int(AUTHORITY_MANIFEST["maxClockSkewSeconds"]),
    )


def fixture_payload(contract_address, **overrides):
    values = {
        "domain": DOMAIN,
        "schema_version": sp.nat(SCHEMA_VERSION),
        "chain_id": sp.chain_id_cst("0xd3166e11"),
        "owner": sp.address("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb"),
        "source": sp.address("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb"),
        "destination": contract_address,
        "entrypoint": ENTRYPOINT,
        "attached_mutez": sp.mutez(0),
        "service_commitment": sp.bytes("0x" + "11" * 32),
        "content_version": "phase-1-evening-service-v1",
        "nonce": sp.bytes("0x" + "22" * 32),
        "issued_at": sp.timestamp(1770000000),
        "expiry": sp.timestamp(1770000900),
        "deployment_manifest_hash": sp.bytes("0x" + AUTHORITY_MANIFEST_HASH),
        "issuer_key_id": AUTHORITY_MANIFEST["issuerPolicies"][0]["keyId"],
        "issuer_policy_version": sp.nat(1),
    }
    values.update(overrides)
    return sp.cast(sp.record(**values), receipt_v1.payload_type)


def fixture_permit(payload):
    payload_hash = sp.blake2b(sp.pack(payload))
    return sp.cast(
        sp.record(
            payload=payload,
            payload_hash=payload_hash,
            signature=sp.make_signature(
                secret_key=FIXTURE_ISSUER_SECRET_KEY,
                message=payload_hash,
                message_format="Raw",
            ),
        ),
        receipt_v1.permit_type,
    )


@sp.add_test()
def compile_and_verify_receipt_contract():
    scenario = sp.test_scenario("samurai_sushi_receipt_v1", receipt_v1)
    contract = receipt_contract()
    scenario += contract

    golden = GOLDEN_VECTOR["payload"]
    golden_payload = sp.cast(
        sp.record(
            domain=golden["domain"],
            schema_version=sp.nat(golden["schemaVersion"]),
            chain_id=sp.chain_id_cst("0xd3166e11"),
            owner=sp.address(golden["owner"]),
            source=sp.address(golden["source"]),
            destination=sp.address(golden["destination"]),
            entrypoint=golden["entrypoint"],
            attached_mutez=sp.mutez(int(golden["attachedMutez"])),
            service_commitment=sp.bytes("0x" + golden["serviceCommitment"]),
            content_version=golden["contentVersion"],
            nonce=sp.bytes("0x" + golden["nonce"]),
            issued_at=sp.timestamp(int(golden["issuedAt"])),
            expiry=sp.timestamp(int(golden["expiry"])),
            deployment_manifest_hash=sp.bytes(
                "0x" + golden["deploymentManifestHash"]
            ),
            issuer_key_id=golden["issuerKeyId"],
            issuer_policy_version=sp.nat(int(golden["issuerPolicyVersion"])),
        ),
        receipt_v1.payload_type,
    )
    scenario.verify(sp.pack(golden_payload) == sp.bytes("0x" + GOLDEN_VECTOR["packedHex"]))
    scenario.verify(
        sp.blake2b(sp.pack(golden_payload))
        == sp.bytes("0x" + GOLDEN_VECTOR["payloadHash"])
    )
    scenario.verify(
        sp.check_signature(
            sp.key(AUTHORITY_MANIFEST["issuerPolicies"][0]["publicKey"]),
            sp.signature(GOLDEN_VECTOR["signature"]),
            sp.bytes("0x" + GOLDEN_VECTOR["payloadHash"]),
        )
    )

    owner = sp.address("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb")
    issued_at = sp.timestamp(1770000000)
    payload = sp.cast(
        sp.record(
            domain=DOMAIN,
            schema_version=sp.nat(SCHEMA_VERSION),
            chain_id=sp.chain_id_cst("0xd3166e11"),
            owner=owner,
            source=owner,
            destination=contract.address,
            entrypoint=ENTRYPOINT,
            attached_mutez=sp.mutez(0),
            service_commitment=sp.bytes("0x" + "11" * 32),
            content_version="phase-1-evening-service-v1",
            nonce=sp.bytes("0x" + "22" * 32),
            issued_at=issued_at,
            expiry=sp.timestamp(1770000900),
            deployment_manifest_hash=sp.bytes("0x" + AUTHORITY_MANIFEST_HASH),
            issuer_key_id=AUTHORITY_MANIFEST["issuerPolicies"][0]["keyId"],
            issuer_policy_version=sp.nat(1),
        ),
        receipt_v1.payload_type,
    )
    payload_hash = sp.blake2b(sp.pack(payload))
    signature = sp.make_signature(
        secret_key=FIXTURE_ISSUER_SECRET_KEY,
        message=payload_hash,
        message_format="Raw",
    )
    permit = sp.cast(
        sp.record(payload=payload, payload_hash=payload_hash, signature=signature),
        receipt_v1.permit_type,
    )
    contract.submit_receipt(
        permit,
        _sender=owner,
        _now=issued_at,
        _chain_id=sp.chain_id_cst("0xd3166e11"),
    )
    scenario.verify(contract.data.receipts.contains(payload_hash))
    scenario.verify(contract.data.used_nonces.contains(sp.bytes("0x" + "22" * 32)))
    scenario.verify(
        contract.data.used_owner_commitments.contains(
            (owner, sp.bytes("0x" + "11" * 32))
        )
    )
    contract.submit_receipt(
        permit,
        _sender=owner,
        _now=issued_at,
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_NONCE_USED",
    )

    contract.set_paused(True, _sender=sp.address(AUTHORITY_MANIFEST["pauseController"]))
    contract.submit_receipt(
        permit,
        _sender=owner,
        _now=issued_at,
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_PAUSED",
    )
    contract.set_paused(False, _sender=sp.address(AUTHORITY_MANIFEST["pauseController"]))
    contract.revoke_issuer(
        AUTHORITY_MANIFEST["issuerPolicies"][0]["keyId"],
        _sender=sp.address(AUTHORITY_MANIFEST["sourceAdministrator"]),
    )
    scenario.verify(
        contract.data.issuer_policies[
            AUTHORITY_MANIFEST["issuerPolicies"][0]["keyId"]
        ].revoked
    )


@sp.add_test()
def reject_hostile_receipt_inputs_without_records_or_events():
    scenario = sp.test_scenario("samurai_sushi_receipt_v1_hostile", receipt_v1)
    contract = receipt_contract()
    scenario += contract
    alice = sp.address("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb")
    bob = sp.address("tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6")
    base_payload = fixture_payload(contract.address)
    base_permit = fixture_permit(base_payload)

    tampered_fields = [
        ("RECEIPT_DOMAIN", {"domain": "SAMURAI_SUSHI_RECEIPT_V2"}),
        ("RECEIPT_SCHEMA", {"schema_version": sp.nat(2)}),
        ("RECEIPT_CHAIN", {"chain_id": sp.chain_id_cst("0x7a06a770")}),
        ("RECEIPT_OWNER", {"owner": bob}),
        ("RECEIPT_SOURCE", {"source": bob}),
        ("RECEIPT_DESTINATION", {"destination": sp.address("KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton")}),
        ("RECEIPT_ENTRYPOINT", {"entrypoint": "transfer"}),
        ("RECEIPT_PAYLOAD_MUTEZ", {"attached_mutez": sp.mutez(1)}),
        ("RECEIPT_PAYLOAD_HASH", {"service_commitment": sp.bytes("0x" + "33" * 32)}),
        ("RECEIPT_PAYLOAD_HASH", {"nonce": sp.bytes("0x" + "44" * 32)}),
        ("RECEIPT_PAYLOAD_HASH", {"issued_at": sp.timestamp(1770000001)}),
        ("RECEIPT_PAYLOAD_HASH", {"expiry": sp.timestamp(1770000899)}),
        ("RECEIPT_MANIFEST", {"deployment_manifest_hash": sp.bytes("0x" + "55" * 32)}),
        ("RECEIPT_ISSUER_KEY", {"issuer_key_id": "foreign-issuer"}),
        ("RECEIPT_ISSUER_POLICY", {"issuer_policy_version": sp.nat(2)}),
    ]
    for exception, mutation in tampered_fields:
        payload = fixture_payload(contract.address, **mutation)
        permit = sp.cast(
            sp.record(
                payload=payload,
                payload_hash=base_permit.payload_hash,
                signature=base_permit.signature,
            ),
            receipt_v1.permit_type,
        )
        contract.submit_receipt(
            permit,
            _sender=alice,
            _now=sp.timestamp(1770000000),
            _chain_id=sp.chain_id_cst("0xd3166e11"),
            _valid=False,
            _exception=exception,
        )

    freshly_signed_wrong_version = fixture_permit(
        fixture_payload(
            contract.address,
            content_version="phase-1-evening-service-v999",
        )
    )
    contract.submit_receipt(
        freshly_signed_wrong_version,
        _sender=alice,
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_CONTENT_VERSION",
    )

    bad_hash = sp.cast(
        sp.record(
            payload=base_payload,
            payload_hash=sp.bytes("0x" + "66" * 32),
            signature=base_permit.signature,
        ),
        receipt_v1.permit_type,
    )
    contract.submit_receipt(
        bad_hash,
        _sender=alice,
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_PAYLOAD_HASH",
    )
    bad_signature = sp.cast(
        sp.record(
            payload=base_payload,
            payload_hash=base_permit.payload_hash,
            signature=sp.signature(GOLDEN_VECTOR["signature"]),
        ),
        receipt_v1.permit_type,
    )
    contract.submit_receipt(
        bad_signature,
        _sender=alice,
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_SIGNATURE",
    )
    contract.submit_receipt(
        base_permit,
        _sender=bob,
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_OWNER",
    )
    contract.submit_receipt(
        base_permit,
        _sender=alice,
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0x7a06a770"),
        _valid=False,
        _exception="RECEIPT_CHAIN",
    )
    contract.submit_receipt(
        base_permit,
        _sender=alice,
        _amount=sp.mutez(1),
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_NONZERO_MUTEZ",
    )

    contract.submit_receipt(
        base_permit,
        _sender=alice,
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0xd3166e11"),
    )
    same_nonce = fixture_permit(
        fixture_payload(
            contract.address,
            service_commitment=sp.bytes("0x" + "77" * 32),
        )
    )
    contract.submit_receipt(
        same_nonce,
        _sender=alice,
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_NONCE_USED",
    )
    same_commitment = fixture_permit(
        fixture_payload(contract.address, nonce=sp.bytes("0x" + "88" * 32))
    )
    contract.submit_receipt(
        same_commitment,
        _sender=alice,
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_COMMITMENT_USED",
    )
    scenario.verify(contract.data.receipts.contains(base_permit.payload_hash))
    scenario.verify(~contract.data.receipts.contains(sp.bytes("0x" + "66" * 32)))

    contract.set_paused(True, _sender=alice)
    paused_permit = fixture_permit(
        fixture_payload(
            contract.address,
            service_commitment=sp.bytes("0x" + "99" * 32),
            nonce=sp.bytes("0x" + "aa" * 32),
        )
    )
    contract.submit_receipt(
        paused_permit,
        _sender=alice,
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_PAUSED",
    )
    contract.set_paused(False, _sender=alice)
    contract.revoke_issuer(
        AUTHORITY_MANIFEST["issuerPolicies"][0]["keyId"], _sender=alice
    )
    contract.submit_receipt(
        paused_permit,
        _sender=alice,
        _now=sp.timestamp(1770000000),
        _chain_id=sp.chain_id_cst("0xd3166e11"),
        _valid=False,
        _exception="RECEIPT_ISSUER_REVOKED",
    )


@sp.add_test()
def enforce_half_open_time_and_privilege_boundaries():
    scenario = sp.test_scenario("samurai_sushi_receipt_v1_boundaries", receipt_v1)
    alice = sp.address("tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb")
    bob = sp.address("tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6")

    privilege_contract = receipt_contract()
    scenario += privilege_contract
    privilege_contract.set_paused(
        True, _sender=bob, _valid=False, _exception="RECEIPT_NOT_PAUSE_CONTROLLER"
    )
    privilege_contract.revoke_issuer(
        AUTHORITY_MANIFEST["issuerPolicies"][0]["keyId"],
        _sender=bob,
        _valid=False,
        _exception="RECEIPT_NOT_ADMINISTRATOR",
    )

    def boundary_case(label, payload, now, valid=True, exception=None, policy=None):
        nonlocal scenario
        selected_policy = policy if policy is not None else authority_policy()
        key_id = AUTHORITY_MANIFEST["issuerPolicies"][0]["keyId"]
        contract = receipt_v1.ReceiptAuthority(
            administrator=alice,
            pause_controller=alice,
            chain_id=sp.chain_id_cst("0xd3166e11"),
            content_version=AUTHORITY_MANIFEST["contentVersion"],
            deployment_manifest_hash=sp.bytes("0x" + AUTHORITY_MANIFEST_HASH),
            issuer_policies=sp.big_map({key_id: selected_policy}),
            maximum_permit_lifetime_seconds=sp.nat(900),
            max_clock_skew_seconds=sp.int(30),
        )
        scenario += contract
        bound_payload = fixture_payload(contract.address, **payload)
        permit = fixture_permit(bound_payload)
        if valid:
            contract.submit_receipt(
                permit,
                _sender=alice,
                _now=sp.timestamp(now),
                _chain_id=sp.chain_id_cst("0xd3166e11"),
            )
            scenario.verify(contract.data.receipts.contains(permit.payload_hash))
        else:
            contract.submit_receipt(
                permit,
                _sender=alice,
                _now=sp.timestamp(now),
                _chain_id=sp.chain_id_cst("0xd3166e11"),
                _valid=False,
                _exception=exception,
            )
            scenario.verify(~contract.data.receipts.contains(permit.payload_hash))

    activation = 1767225600
    retirement = 2051222400
    boundary_case(
        "activation-inclusive",
        {"issued_at": sp.timestamp(activation), "expiry": sp.timestamp(activation + 1)},
        activation,
    )
    boundary_case(
        "below-activation",
        {"issued_at": sp.timestamp(activation - 1), "expiry": sp.timestamp(activation)},
        activation - 1,
        False,
        "RECEIPT_NOT_ACTIVE",
    )
    boundary_case(
        "retirement-exclusive",
        {"issued_at": sp.timestamp(retirement), "expiry": sp.timestamp(retirement + 1)},
        retirement,
        False,
        "RECEIPT_RETIRED",
    )
    boundary_case(
        "lifetime-inclusive",
        {"issued_at": sp.timestamp(1770000000), "expiry": sp.timestamp(1770000900)},
        1770000000,
    )
    boundary_case(
        "lifetime-overflow",
        {"issued_at": sp.timestamp(1770000000), "expiry": sp.timestamp(1770000901)},
        1770000000,
        False,
        "RECEIPT_LIFETIME",
    )
    boundary_case(
        "clock-skew-inclusive",
        {"issued_at": sp.timestamp(1770000030), "expiry": sp.timestamp(1770000900)},
        1770000000,
    )
    boundary_case(
        "clock-skew-overflow",
        {"issued_at": sp.timestamp(1770000031), "expiry": sp.timestamp(1770000900)},
        1770000000,
        False,
        "RECEIPT_CLOCK_SKEW",
    )
    boundary_case(
        "expiry-exclusive",
        {"issued_at": sp.timestamp(1770000000), "expiry": sp.timestamp(1770000010)},
        1770000010,
        False,
        "RECEIPT_EXPIRED",
    )
    boundary_case(
        "zero-duration",
        {"issued_at": sp.timestamp(1770000000), "expiry": sp.timestamp(1770000000)},
        1770000000,
        False,
        "RECEIPT_DURATION",
    )

    short_verify_policy = sp.record(
        policy_version=sp.nat(1),
        public_key=sp.key(AUTHORITY_MANIFEST["issuerPolicies"][0]["publicKey"]),
        activates_at=sp.timestamp(1767225600),
        retires_at=sp.timestamp(1770000050),
        verify_until=sp.timestamp(1770000100),
        revoked=False,
    )
    boundary_case(
        "verify-until-exclusive",
        {"issued_at": sp.timestamp(1770000000), "expiry": sp.timestamp(1770000200)},
        1770000100,
        False,
        "RECEIPT_VERIFY_UNTIL",
        short_verify_policy,
    )

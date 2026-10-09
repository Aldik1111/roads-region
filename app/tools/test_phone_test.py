import importlib.util
import ipaddress
import ssl
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from cryptography import x509

spec = importlib.util.spec_from_file_location("phone_test", Path(__file__).with_name("phone_test.py"))
phone = importlib.util.module_from_spec(spec)
spec.loader.exec_module(phone)


def test_certificate_matches_lan_address_and_reuses_existing_identity(tmp_path):
    info = phone.prepare(tmp_path, "192.168.1.108", 8443, 8444)
    cert = x509.load_pem_x509_certificate((tmp_path / "server.pem").read_bytes())
    assert ipaddress.ip_address("192.168.1.108") in cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.IPAddress)
    root = x509.load_pem_x509_certificate((tmp_path / "roads-phone-ca.crt").read_bytes())
    cert.verify_directly_issued_by(root)
    assert root.extensions.get_extension_for_class(x509.BasicConstraints).value.path_length == 0
    assert phone.prepare(tmp_path, "192.168.1.108", 8443, 8444)["fingerprint"] == info["fingerprint"]
    assert not (tmp_path / "ca-key.pem").exists()
    ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(tmp_path / "server.pem", tmp_path / "server-key.pem")


def test_changed_address_requires_explicit_certificate_renewal(tmp_path):
    info = phone.prepare(tmp_path, "192.168.1.108", 8443, 8444)
    with pytest.raises(ValueError, match="Renew"):
        phone.prepare(tmp_path, "192.168.1.109", 8443, 8444)
    fresh = phone.prepare(tmp_path, "192.168.1.109", 8443, 8444, renew=True)
    assert fresh["fingerprint"] != info["fingerprint"]


@pytest.mark.parametrize("address", ["0.0.0.0", "127.0.0.1", "8.8.8.8", "26.1.2.3", "169.254.1.1", "::1"])
def test_only_rfc1918_lan_addresses_are_allowed(tmp_path, address):
    with pytest.raises(ValueError):
        phone.prepare(tmp_path, address, 8443, 8444)


def test_setup_server_serves_only_public_setup_assets(tmp_path):
    phone.prepare(tmp_path, "192.168.1.108", 8443, 8444)
    server = phone.make_setup_server(tmp_path, "127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        for route in ["/", "/roads-phone-ca.crt", "/qr.png"]:
            with urllib.request.urlopen(base + route) as result:
                assert result.status == 200
                assert result.headers["Cache-Control"] == "no-store"
        for route in ["/server-key.pem", "/server.pem", "/connection.json", "/../server-key.pem", "/%2e%2e/server-key.pem", "/api/me"]:
            with pytest.raises(urllib.error.HTTPError) as failure:
                urllib.request.urlopen(base + route)
            assert failure.value.code == 404
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

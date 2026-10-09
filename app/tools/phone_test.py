"""Local phone-test certificates and a public-assets-only onboarding server.

No root signing key is written to disk. Replacing the IP/certificate requires
explicit renewal and reinstalling the public CA certificate on the phone.
"""
import argparse
import ipaddress
import json
import ssl
import sys
import threading
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
import qrcode

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".phone-test"
NETWORKS = tuple(ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def lan_address(value):
    address = ipaddress.ip_address(value)
    if address.version != 4 or not any(address in network for network in NETWORKS):
        raise ValueError("Use an RFC1918 IPv4 address from the PC's local Wi-Fi/Ethernet interface.")
    return address


def prepare(directory, address, https_port, setup_port, renew=False):
    address = lan_address(address)
    if not all(1024 <= port <= 65535 for port in (https_port, setup_port)) or https_port == setup_port:
        raise ValueError("Use two distinct ports in range 1024..65535.")
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    if (directory / "connection.json").exists() and not renew:
        previous = json.loads((directory / "connection.json").read_text(encoding="utf-8"))
        if previous["ip"] != str(address):
            raise ValueError("IP changed: use -RenewCertificate and reinstall the new CA on the phone.")
        cert = x509.load_pem_x509_certificate((directory / "server.pem").read_bytes())
        if cert.not_valid_after_utc < now + timedelta(days=1):
            raise ValueError("Certificate expires soon: use -RenewCertificate and reinstall the new CA on the phone.")
        root = x509.load_pem_x509_certificate((directory / "roads-phone-ca.crt").read_bytes())
        cert.verify_directly_issued_by(root)
        if address not in cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.IPAddress):
            raise ValueError("Certificate address mismatch; use -RenewCertificate.")
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(directory / "server.pem", directory / "server-key.pem")
    else:
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Roads Phone Test Local CA")])
        root = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
                .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=30))
                .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
                .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
                .sign(ca_key, hashes.SHA256()))
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cert = (x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, str(address))]))
                .issuer_name(ca_name).public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=14))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.SubjectAlternativeName([x509.IPAddress(address)]), critical=False)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                .add_extension(x509.KeyUsage(True, False, True, False, False, False, False, False, False), critical=True)
                .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
                .sign(ca_key, hashes.SHA256()))
        (directory / "server-key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        (directory / "server.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (directory / "roads-phone-ca.crt").write_bytes(root.public_bytes(serialization.Encoding.PEM))
        # ca_key deliberately exists only in memory; this CA cannot issue later certificates.
    info = {"ip": str(address), "https_port": https_port, "setup_port": setup_port,
            "app_url": f"https://{address}:{https_port}", "setup_url": f"http://{address}:{setup_port}",
            "fingerprint": root.fingerprint(hashes.SHA256()).hex(":"),
            "expires_at": cert.not_valid_after_utc.isoformat()}
    qrcode.make(info["setup_url"]).save(directory / "qr.png")
    (directory / "connection.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    (directory / "index.html").write_text(setup_page(info), encoding="utf-8")
    return info


def setup_page(info):
    return f'''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Дороги — подключение телефона</title>
<style>body{{font:16px/1.6 system-ui,sans-serif;background:#f4f5ef;color:#172a24;margin:0;padding:24px}}main{{max-width:640px;margin:auto;background:white;padding:24px;border:1px solid #dce1d9;border-radius:18px}}h1{{font-size:26px;line-height:1.2}}a{{color:#126e60}}.button{{display:block;padding:14px;margin:14px 0;text-align:center;border-radius:10px;background:#126e60;color:white;text-decoration:none;font-weight:700}}img{{display:block;width:210px;max-width:100%;margin:12px auto}}code{{overflow-wrap:anywhere;font-size:12px}}li{{margin-bottom:12px}}small{{color:#60736a}}.note{{padding:14px;background:#fff4da;border-radius:10px}}</style>
<main><small>ДОРОГИ ОБЛАСТИ · ТЕСТ В ЛОКАЛЬНОЙ СЕТИ</small><h1>Подключить Android</h1>
<p>Телефон и ПК должны быть в одной Wi-Fi-сети. ПК должен оставаться включённым.</p><img src="/qr.png" alt="QR-код этой страницы подключения"><p>{info['setup_url']}</p>
<ol><li><a href="/roads-phone-ca.crt" download>Скачать сертификат Roads Phone Test</a>.</li>
<li>В настройках Android найдите «Установка сертификатов» → <b>Сертификат ЦС / CA</b> и выберите скачанный файл. Названия пунктов зависят от производителя. Это сертификат доверия для сайта, не сертификат Wi-Fi.</li>
<li>Откройте защищённую проверку ниже. В Chrome не должно быть предупреждения о недоверенном сертификате. Разрешите местоположение при запросе.</li></ol>
<a class="button" href="{info['app_url']}/phone-check.html">Проверить соединение и GPS</a><a class="button" href="{info['app_url']}/">Открыть приложение</a>
<p class="note">Android предупредит об установке центра сертификации. Устанавливайте только сертификат с этого ПК; после теста удалите именно «Roads Phone Test Local CA» в настройках доверенных пользовательских сертификатов. Не очищайте всё хранилище.</p>
<p>SHA-256 сертификата — сравните с данными на ПК:<br><code>{info['fingerprint']}</code></p>
<p><small>HTTPS-сертификат действителен до {info['expires_at'][:10]}. При смене адреса ПК потребуется перевыпуск. На этой HTTP-странице нет входа в приложение и запросов геолокации.</small></p></main></html>'''


def make_setup_server(directory, address, port):
    directory = Path(directory)
    allowed = {"/": ("index.html", "text/html; charset=utf-8"),
               "/roads-phone-ca.crt": ("roads-phone-ca.crt", "application/x-x509-ca-cert"),
               "/qr.png": ("qr.png", "image/png")}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            entry = allowed.get(urlsplit(self.path).path)
            if entry is None:
                self.send_error(404)
                return
            filename, content_type = entry
            data = (directory / filename).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if filename.endswith(".crt"):
                self.send_header("Content-Disposition", 'attachment; filename="roads-phone-ca.crt"')
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_):
            pass

    return ThreadingHTTPServer((address, port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "serve", "check"])
    parser.add_argument("--ip", required=True)
    parser.add_argument("--https-port", type=int, default=8443)
    parser.add_argument("--setup-port", type=int, default=8444)
    parser.add_argument("--renew", action="store_true")
    args = parser.parse_args()
    lan_address(args.ip)
    if args.action == "prepare":
        print(json.dumps(prepare(STATE, args.ip, args.https_port, args.setup_port, args.renew), indent=2))
    elif args.action == "check":
        context = ssl.create_default_context(cafile=str(STATE / "roads-phone-ca.crt"))
        # Ignore proxy environment: this is a direct local-network connection.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
        try:
            with opener.open(f"https://{args.ip}:{args.https_port}/api/health", timeout=3) as response:
                result = json.load(response)
                if not result.get("ok"):
                    raise RuntimeError("HTTPS health check failed")
                print(json.dumps(result))
        except (OSError, ValueError, RuntimeError) as error:
            # A failed readiness probe should not become a terminating native
            # stderr error in Windows PowerShell before the launcher can retry.
            print(json.dumps({"ok": False, "error": str(error)}))
            raise SystemExit(1)
    else:
        info = json.loads((STATE / "connection.json").read_text(encoding="utf-8"))
        if (info["ip"], info["https_port"], info["setup_port"]) != (args.ip, args.https_port, args.setup_port):
            raise ValueError("Run prepare with matching IP and ports first.")
        setup = make_setup_server(STATE, args.ip, args.setup_port)
        thread = threading.Thread(target=setup.serve_forever, daemon=True)
        thread.start()
        sys.path.insert(0, str(ROOT / "backend"))
        import uvicorn
        try:
            uvicorn.run("app.main:app", host=args.ip, port=args.https_port, proxy_headers=False,
                        ssl_keyfile=str(STATE / "server-key.pem"), ssl_certfile=str(STATE / "server.pem"),
                        ssl_version=ssl.PROTOCOL_TLS_SERVER)
        finally:
            setup.shutdown()
            setup.server_close()


if __name__ == "__main__":
    main()

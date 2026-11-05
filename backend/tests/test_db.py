"""The IPv4 preference used when connecting to a hosted database."""
import socket

from app import db


def test_prefers_the_ipv4_address(monkeypatch):
    calls = {}

    def fake_getaddrinfo(host, port, family, kind):
        calls["family"] = family
        return [(socket.AF_INET, kind, 6, "", ("3.77.164.229", port))]

    monkeypatch.setattr(db.socket, "getaddrinfo", fake_getaddrinfo)
    params = {"host": "ep-example.eu-central-1.aws.neon.tech", "port": 5432}
    db.prefer_ipv4(params)
    assert params["hostaddr"] == "3.77.164.229"
    assert params["host"] == "ep-example.eu-central-1.aws.neon.tech"   # kept for TLS
    assert calls["family"] == socket.AF_INET


def test_leaves_params_alone_without_ipv4(monkeypatch):
    def no_ipv4(*args):
        raise socket.gaierror("no A record")

    monkeypatch.setattr(db.socket, "getaddrinfo", no_ipv4)
    params = {"host": "ipv6-only.example", "port": 5432}
    db.prefer_ipv4(params)
    assert "hostaddr" not in params


def test_localhost_is_untouched():
    params = {"host": "localhost", "port": 5432}
    db.prefer_ipv4(params)
    assert "hostaddr" not in params

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from init_deploy import create_env


def test_private_env_has_unique_secret_and_cannot_overwrite(tmp_path, capsys):
    first, second = tmp_path / 'first.env', tmp_path / 'second.env'
    create_env('Roads.Example.com', first)
    create_env('roads.example.com', second)
    content = first.read_text()
    assert re.fullmatch(r'APP_DOMAIN=roads.example.com\nPOSTGRES_PASSWORD=[0-9a-f]{64}\n', content)
    assert content != second.read_text()
    assert not capsys.readouterr().out
    with pytest.raises(FileExistsError):
        create_env('other.example.com', first)
    assert first.read_text() == content


@pytest.mark.parametrize('domain', ['https://example.com', 'example.com:443', 'example.com\nINJECT=yes', '../example.com', 'localhost'])
def test_invalid_host_does_not_create_env(tmp_path, domain):
    target = tmp_path / 'production.env'
    with pytest.raises(ValueError):
        create_env(domain, target)
    assert not target.exists()

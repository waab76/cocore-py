from cocore_provider import __version__
from cocore_provider.cli import main


def test_version_flag_prints_version(capsys: object) -> None:
    exit_code = main(["--version"])
    assert exit_code == 0
    captured = capsys.readouterr()  # type: ignore[attr-defined]
    assert captured.out.strip() == __version__

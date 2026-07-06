from __future__ import annotations

import logging
from pathlib import Path

from cocore_provider.logging_setup import configure_logging


def test_configure_logging_sets_level_and_console_handler() -> None:
    configure_logging("DEBUG", None)
    logger = logging.getLogger("cocore_provider")
    assert logger.level == logging.DEBUG
    assert len(logger.handlers) == 1
    assert type(logger.handlers[0]) is logging.StreamHandler
    assert logger.propagate is False


def test_configure_logging_adds_file_handler_and_creates_parent_dir(tmp_path: Path) -> None:
    log_file = tmp_path / "nested" / "provider.log"
    configure_logging("INFO", log_file)
    logger = logging.getLogger("cocore_provider")
    assert len(logger.handlers) == 2

    logger.info("hello from test")
    for handler in logger.handlers:
        handler.flush()

    assert log_file.exists()
    assert "hello from test" in log_file.read_text()


def test_configure_logging_is_idempotent_and_replaces_handlers(tmp_path: Path) -> None:
    log_file = tmp_path / "provider.log"
    configure_logging("INFO", log_file)
    configure_logging("INFO", log_file)
    logger = logging.getLogger("cocore_provider")
    assert len(logger.handlers) == 2


def test_configure_logging_without_log_file_has_only_console_handler(tmp_path: Path) -> None:
    log_file = tmp_path / "provider.log"
    configure_logging("INFO", log_file)
    configure_logging("INFO", None)
    logger = logging.getLogger("cocore_provider")
    assert len(logger.handlers) == 1
    assert type(logger.handlers[0]) is logging.StreamHandler

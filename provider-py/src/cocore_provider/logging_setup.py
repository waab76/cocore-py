"""Wires up console + rotating-file logging for every `cocore_provider.*`
logger. Every module in this package logs via `logging.getLogger(__name__)`
and does nothing to configure output itself -- this is the one place that
decides where those records go, so `cli.main()` is the only caller."""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

_FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"
_MAX_BYTES = 5 * 1024 * 1024
_BACKUP_COUNT = 3

_PACKAGE_LOGGER_NAME = "cocore_provider"


def configure_logging(level: str, log_file: Path | None) -> None:
    """(Re-)configure the `cocore_provider` logger tree. Idempotent: safe to
    call more than once (e.g. across tests) since it replaces rather than
    accumulates handlers."""
    package_logger = logging.getLogger(_PACKAGE_LOGGER_NAME)
    package_logger.setLevel(level)
    for handler in package_logger.handlers[:]:
        handler.close()
        package_logger.removeHandler(handler)
    # Don't also let the root logger's handlers (or last-resort stderr
    # handler) see and re-emit these records.
    package_logger.propagate = False

    formatter = logging.Formatter(_FORMAT)

    console_handler = logging.StreamHandler(sys.stderr)
    console_handler.setFormatter(formatter)
    package_logger.addHandler(console_handler)

    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_file, maxBytes=_MAX_BYTES, backupCount=_BACKUP_COUNT, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        package_logger.addHandler(file_handler)

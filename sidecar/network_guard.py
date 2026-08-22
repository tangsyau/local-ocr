"""Best-effort Python network guard used only during document inference."""

from __future__ import annotations

import socket
from contextlib import contextmanager
from collections.abc import Iterator


class NetworkBlockedError(RuntimeError):
    pass


@contextmanager
def block_python_network() -> Iterator[None]:
    """Temporarily deny Python socket connections while OCR reads a document.

    This blocks Python networking APIs, including HTTP libraries built on sockets.
    It is intentionally not enabled while models are being downloaded.
    """

    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_create_connection = socket.create_connection

    def denied(*_args: object, **_kwargs: object) -> None:
        raise NetworkBlockedError("Network access is disabled during OCR inference")

    def denied_ex(*_args: object, **_kwargs: object) -> int:
        raise NetworkBlockedError("Network access is disabled during OCR inference")

    socket.socket.connect = denied  # type: ignore[method-assign]
    socket.socket.connect_ex = denied_ex  # type: ignore[method-assign]
    socket.create_connection = denied  # type: ignore[assignment]
    try:
        yield
    finally:
        socket.socket.connect = original_connect  # type: ignore[method-assign]
        socket.socket.connect_ex = original_connect_ex  # type: ignore[method-assign]
        socket.create_connection = original_create_connection


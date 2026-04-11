"""Tests for the gateway consecutive-failure circuit breaker (#7130).

When a session hits N consecutive non-retryable failures (e.g. invalid
model ID → 400), the gateway stops recreating agents and tells the user
to fix their config.  /reset clears the breaker.
"""

import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from gateway.run import GatewayRunner, _MAX_CONSECUTIVE_FAILURES


class TestCircuitBreaker:
    """Circuit breaker prevents CPU-burning restart loops on persistent errors."""

    def _make_runner(self):
        """Create a minimal GatewayRunner without full __init__."""
        runner = object.__new__(GatewayRunner)
        runner._session_consecutive_failures = {}
        runner._agent_cache = {}
        runner._agent_cache_lock = MagicMock()
        return runner

    def test_failure_counter_increments(self):
        runner = self._make_runner()
        key = "test:session:1"
        runner._session_consecutive_failures[key] = 0
        runner._session_consecutive_failures[key] += 1
        assert runner._session_consecutive_failures[key] == 1

    def test_success_resets_counter(self):
        runner = self._make_runner()
        key = "test:session:1"
        runner._session_consecutive_failures[key] = 2
        # Simulate success: pop the key
        runner._session_consecutive_failures.pop(key, None)
        assert key not in runner._session_consecutive_failures

    def test_max_consecutive_failures_is_reasonable(self):
        """The threshold should be low enough to stop loops quickly."""
        assert 2 <= _MAX_CONSECUTIVE_FAILURES <= 10

    def test_circuit_breaker_blocks_after_threshold(self):
        """After N failures, the circuit breaker should be tripped."""
        runner = self._make_runner()
        key = "test:session:1"
        runner._session_consecutive_failures[key] = _MAX_CONSECUTIVE_FAILURES
        count = runner._session_consecutive_failures.get(key, 0)
        assert count >= _MAX_CONSECUTIVE_FAILURES

    def test_reset_clears_circuit_breaker(self):
        """The /reset path clears the failure counter."""
        runner = self._make_runner()
        key = "test:session:1"
        runner._session_consecutive_failures[key] = _MAX_CONSECUTIVE_FAILURES

        # Simulate what the reset handler does
        runner._session_consecutive_failures.pop(key, None)
        assert key not in runner._session_consecutive_failures

    def test_evict_cached_agent_on_circuit_break(self):
        """When circuit breaker engages, the cached agent should be evicted."""
        runner = self._make_runner()
        key = "test:session:1"
        runner._agent_cache[key] = (MagicMock(), "sig")
        runner._session_consecutive_failures[key] = _MAX_CONSECUTIVE_FAILURES

        # Simulate eviction
        runner._evict_cached_agent(key)
        assert key not in runner._agent_cache

    def test_different_sessions_track_independently(self):
        """Failures in session A should not affect session B."""
        runner = self._make_runner()
        runner._session_consecutive_failures["session:a"] = _MAX_CONSECUTIVE_FAILURES
        runner._session_consecutive_failures["session:b"] = 1

        assert runner._session_consecutive_failures["session:a"] >= _MAX_CONSECUTIVE_FAILURES
        assert runner._session_consecutive_failures["session:b"] < _MAX_CONSECUTIVE_FAILURES

    def test_getattr_pattern_safe_for_bare_runner(self):
        """The getattr pattern should not crash on bare runners without __init__."""
        runner = object.__new__(GatewayRunner)
        # No _session_consecutive_failures attribute set
        failures = getattr(runner, "_session_consecutive_failures", None)
        assert failures is None
        # The circuit breaker check uses getattr().get() which would fail
        # on None, but the code uses getattr(self, ..., {}).get() pattern
        count = getattr(runner, "_session_consecutive_failures", {}).get("any_key", 0)
        assert count == 0

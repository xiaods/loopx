"""Tests for the worker lifecycle state projection.

These tests verify that the lifecycle state is derived from existing facts
only (registry membership, todo claims, session bindings, activity timestamps)
and does not introduce a second source of truth.

State priority (highest first):
1. blocked      — current todo is blocked or a blocker
2. executing    — has active todo with recent activity (within stale threshold)
3. bound        — has session binding and active todo
4. launchable   — has active todo, no session binding
5. addressable  — has session binding but no active todo
6. registered   — registered in registry, no binding or todo
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from loopx.control_plane.agents.management_projection import (
    WORKER_LIFECYCLE_STATE_ADDRESSABLE,
    WORKER_LIFECYCLE_STATE_BLOCKED,
    WORKER_LIFECYCLE_STATE_BOUND,
    WORKER_LIFECYCLE_STATE_EXECUTING,
    WORKER_LIFECYCLE_STATE_LAUNCHABLE,
    WORKER_LIFECYCLE_STATE_REGISTERED,
    _agent_lifecycle_state,
)


def _todo(
    *,
    status: str = "open",
    task_class: str = "advancement_task",
    claimed_by: str | None = "agent-a",
    updated_at: str | None = None,
) -> dict:
    return {
        "todo_id": "todo_test_001",
        "goal_id": "test-goal",
        "status": status,
        "task_class": task_class,
        "claimed_by": claimed_by,
        "updated_at": updated_at,
    }


def _recent_activity() -> str:
    """Activity timestamp within the stale threshold (36 hours)."""
    return (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()


def _stale_activity() -> str:
    """Activity timestamp beyond the stale threshold (36 hours)."""
    return (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()


class TestLifecycleStateRegistered:
    """Registered: agent in registry, no binding or todo."""

    def test_registered_with_no_todos_no_binding(self) -> None:
        state = _agent_lifecycle_state(
            [],
            current=None,
            has_session_binding=False,
            last_activity_at=None,
        )
        assert state == WORKER_LIFECYCLE_STATE_REGISTERED

    def test_registered_with_done_todos_only(self) -> None:
        done_todo = _todo(status="done")
        state = _agent_lifecycle_state(
            [done_todo],
            current=None,
            has_session_binding=False,
            last_activity_at=None,
        )
        assert state == WORKER_LIFECYCLE_STATE_REGISTERED


class TestLifecycleStateAddressable:
    """Addressable: has session binding but no active todo."""

    def test_addressable_with_binding_no_todos(self) -> None:
        state = _agent_lifecycle_state(
            [],
            current=None,
            has_session_binding=True,
            last_activity_at=None,
        )
        assert state == WORKER_LIFECYCLE_STATE_ADDRESSABLE

    def test_addressable_with_binding_and_done_todos(self) -> None:
        done_todo = _todo(status="done")
        state = _agent_lifecycle_state(
            [done_todo],
            current=None,
            has_session_binding=True,
            last_activity_at=None,
        )
        assert state == WORKER_LIFECYCLE_STATE_ADDRESSABLE


class TestLifecycleStateBound:
    """Bound: has session binding and active todo."""

    def test_bound_with_binding_and_active_todo(self) -> None:
        todo = _todo(claimed_by="agent-a")
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=None,
        )
        assert state == WORKER_LIFECYCLE_STATE_BOUND

    def test_bound_with_binding_and_stale_activity(self) -> None:
        """Bound with stale activity: still bound (has binding + active todo)."""
        todo = _todo(claimed_by="agent-a", updated_at=_stale_activity())
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=_stale_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_BOUND


class TestLifecycleStateLaunchable:
    """Launchable: has active todo, no session binding."""

    def test_launchable_with_active_todo_no_binding(self) -> None:
        todo = _todo(claimed_by="agent-a")
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=False,
            last_activity_at=None,
        )
        assert state == WORKER_LIFECYCLE_STATE_LAUNCHABLE

    def test_launchable_with_stale_activity_no_binding(self) -> None:
        todo = _todo(claimed_by="agent-a", updated_at=_stale_activity())
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=False,
            last_activity_at=_stale_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_LAUNCHABLE


class TestLifecycleStateExecuting:
    """Executing: has active todo with recent activity (within stale threshold)."""

    def test_executing_with_recent_activity(self) -> None:
        todo = _todo(claimed_by="agent-a", updated_at=_recent_activity())
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=_recent_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_EXECUTING

    def test_executing_with_recent_activity_no_binding(self) -> None:
        """Executing requires recent activity; without binding it is still executing."""
        todo = _todo(claimed_by="agent-a", updated_at=_recent_activity())
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=False,
            last_activity_at=_recent_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_EXECUTING


class TestLifecycleStateBlocked:
    """Blocked: current todo is blocked or a blocker. Highest priority."""

    def test_blocked_with_blocked_todo(self) -> None:
        todo = _todo(status="blocked", task_class="blocker")
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=_recent_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_BLOCKED

    def test_blocked_takes_priority_over_executing(self) -> None:
        """Blocked takes priority even with recent activity and binding."""
        todo = _todo(status="blocked", task_class="blocker")
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=_recent_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_BLOCKED

    def test_blocked_with_blocker_task_class(self) -> None:
        todo = _todo(task_class="blocker")
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=_recent_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_BLOCKED

    def test_blocked_with_blocked_status(self) -> None:
        todo = _todo(status="blocked")
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=_recent_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_BLOCKED


class TestLifecycleStatePriority:
    """Verify state priority ordering."""

    def test_blocked_beats_executing(self) -> None:
        todo = _todo(status="blocked", task_class="blocker")
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=_recent_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_BLOCKED

    def test_executing_beats_bound(self) -> None:
        """With recent activity, executing wins over bound."""
        todo = _todo(claimed_by="agent-a", updated_at=_recent_activity())
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=_recent_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_EXECUTING

    def test_bound_beats_launchable(self) -> None:
        """With session binding, bound wins over launchable."""
        todo = _todo(claimed_by="agent-a")
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=None,
        )
        assert state == WORKER_LIFECYCLE_STATE_BOUND

    def test_launchable_beats_addressable(self) -> None:
        """With active todo, launchable wins over addressable."""
        todo = _todo(claimed_by="agent-a")
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=False,
            last_activity_at=None,
        )
        assert state == WORKER_LIFECYCLE_STATE_LAUNCHABLE

    def test_addressable_beats_registered(self) -> None:
        """With session binding, addressable wins over registered."""
        state = _agent_lifecycle_state(
            [],
            current=None,
            has_session_binding=True,
            last_activity_at=None,
        )
        assert state == WORKER_LIFECYCLE_STATE_ADDRESSABLE


class TestLifecycleStateNegativeCases:
    """Negative cases: ensure no second source of truth is introduced."""

    def test_no_todo_no_binding_is_registered(self) -> None:
        """An agent with no todos and no binding is registered, not unknown."""
        state = _agent_lifecycle_state(
            [],
            current=None,
            has_session_binding=False,
            last_activity_at=None,
        )
        assert state == WORKER_LIFECYCLE_STATE_REGISTERED

    def test_done_todos_dont_make_agent_executing(self) -> None:
        """Done todos don't count as active work."""
        done_todo = _todo(status="done", claimed_by="agent-a")
        state = _agent_lifecycle_state(
            [done_todo],
            current=None,
            has_session_binding=True,
            last_activity_at=_recent_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_ADDRESSABLE

    def test_stale_activity_with_binding_is_bound_not_executing(self) -> None:
        """Stale activity with binding is bound, not executing."""
        todo = _todo(claimed_by="agent-a", updated_at=_stale_activity())
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=True,
            last_activity_at=_stale_activity(),
        )
        assert state == WORKER_LIFECYCLE_STATE_BOUND

    def test_unclaimed_todo_doesnt_make_agent_bound(self) -> None:
        """An unclaimed todo doesn't make the agent bound."""
        todo = _todo(claimed_by=None)
        state = _agent_lifecycle_state(
            [todo],
            current=todo,
            has_session_binding=False,
            last_activity_at=None,
        )
        # Unclaimed todo with no binding: still launchable (has active todo)
        assert state == WORKER_LIFECYCLE_STATE_LAUNCHABLE

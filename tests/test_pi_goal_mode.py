from __future__ import annotations

from loopx.pi_goal_mode import extension_source


def test_pi_extension_source_is_managed_and_self_contained() -> None:
    text = extension_source()
    # Managed marker lets install/uninstall retire the file safely.
    assert "loopx-managed-slash-command:v1 command=/loopx surface=pi-extension" in text
    # Self-contained: only type-only imports from the pi package (erased at
    # runtime); runtime imports are node builtins and typebox (loader-aliased).
    pi_package_lines = [
        line
        for line in text.splitlines()
        if "@earendil-works/pi-coding-agent" in line
    ]
    assert pi_package_lines, "extension must type-import the pi package"
    assert all(line.strip().startswith("import type") for line in pi_package_lines), (
        pi_package_lines
    )
    assert "node:" in text


def test_pi_extension_registers_command_tool_and_events() -> None:
    text = extension_source()
    assert 'pi.registerCommand("loopx"' in text
    assert "loopx_goal_activate" in text
    assert "pi.on(\"agent_settled\"" in text
    assert "pi.on(\"before_agent_start\"" in text
    assert "pi.on(\"session_shutdown\"" in text
    # The extension drives the agent through Pi's message API, never by
    # fabricating host-level goal completion.
    assert "sendUserMessage" in text


def test_pi_extension_never_self_declares_closure() -> None:
    text = extension_source()
    # Continuation authority stays with LoopX quota should-run.
    assert "--runtime-profile" in text
    assert "generic_cli" in text
    assert "should-run" in text
    assert "terminal_no_followup" in text
    assert "validated_goal_closure" in text
    # No native goal object exists on Pi; the loop must not fake one.
    assert "goal_complete" not in text
    assert "self-declares closure" in text


def test_pi_extension_binding_state_stays_private_and_scoped() -> None:
    text = extension_source()
    # Bindings persist under the gitignored project .loopx/ tree.
    assert ".loopx" in text
    assert "LOOPX_PI_STATE_DIR" in text
    assert "0o600" in text
    assert "0o700" in text

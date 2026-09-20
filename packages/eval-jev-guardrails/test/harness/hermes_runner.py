"""Import a generated Hermes plugin, register its hooks, invoke pre_tool_call.

Usage: python3 hermes_runner.py <plugin_dir> <tool_name> <args_json> [hook_name]
Prints one JSON object: {"registered": [...], "result": <hook return>}.
"""

import importlib.util
import json
import os
import sys


def main():
    plugin_dir = sys.argv[1]
    tool_name = sys.argv[2]
    args = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else {}
    hook_name = sys.argv[4] if len(sys.argv) > 4 else "pre_tool_call"

    spec = importlib.util.spec_from_file_location(
        "eval_jev_guardrails_plugin_under_test",
        os.path.join(plugin_dir, "__init__.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    captured = {}

    class FakeContext:
        def register_hook(self, name, callback):
            captured[name] = callback

    module.register(FakeContext())
    if hook_name not in captured:
        raise SystemExit("register() did not register hook %r (registered: %s)" % (hook_name, sorted(captured)))

    result = captured[hook_name](
        tool_name=tool_name,
        args=args,
        session_id="session-test",
        tool_call_id="call-test",
        turn_id="turn-test",
    )
    sys.stdout.write(json.dumps({"registered": sorted(captured), "result": result}))


if __name__ == "__main__":
    main()

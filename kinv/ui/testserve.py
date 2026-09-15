"""Starts the UI server for the TypeScript browser tests to drive.

The page's own JavaScript has no Python test harness — there is no JSDOM for
Python — so rather than lose those tests, the TypeScript suite runs them
against this server (``npx vitest run -c vitest.python.config.ts``). It prints
its URL on the first line of stdout and stops when stdin closes, so it cannot
outlive the test that started it.

``--choose-url`` stands in for the folder dialog: each "where?" is POSTed to
that URL, where the test's own answer is waiting.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request

from kinv.ui.server import start_ui_server


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project")
    parser.add_argument("--choose-url")
    args = parser.parse_args()

    choose = None
    if args.choose_url:

        def choose(start: str) -> dict:
            request = urllib.request.Request(
                args.choose_url,
                data=json.dumps({"start": start}).encode("utf8"),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request) as response:
                return json.loads(response.read())

    server, url = start_ui_server(args.project, port=0, choose=choose)
    print(url, flush=True)
    sys.stdin.read()  # returns when the parent closes the pipe, or dies
    server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())

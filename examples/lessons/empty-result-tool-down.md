---
name: empty-result-tool-down
description: An empty search result can mean the search tool is down or the pattern is wrong, not that nothing exists. Check the tool first.
severity: critical
applies_to: [general-purpose, Explore]
---
An empty result has two common causes that look identical to "nothing found": the measuring tool is
not running (stale index, stopped service), or the search pattern is wrong. Before reporting
"does not exist", confirm the tool works on a known-positive query and read its stderr.

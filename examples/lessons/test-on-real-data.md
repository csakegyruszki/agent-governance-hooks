---
name: test-on-real-data
description: Run tests against real captured data; label every synthetic case as synthetic.
severity: critical
metadata:
  applies_to: [general-purpose, code-reviewer]
---
Tests built on invented fixtures only prove the code agrees with the author's assumptions. Prefer
captured real inputs, record where they came from, and mark any synthetic case as synthetic.

git: 
	git add .
	git commit -m "new"
	git push

# ── BeatBot pip package ───────────────────────────────────────────────────────
#
# The CLI is distributed via PyPI (beatbot package), NOT as a zip or binary.
# After changing beatbot/cli.py, beatbot/extractor/, or beatbot/track.py:
#
#   1. Bump version in pyproject.toml
#   2. poetry build
#   3. twine upload dist/*.whl dist/*.tar.gz

publish:
	poetry build
	twine upload dist/*.whl dist/*.tar.gz

.PHONY: publish
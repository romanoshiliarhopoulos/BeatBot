git: 
	git add .
	git commit -m "new"
	git push

# ── Cloud Run deploy ──────────────────────────────────────────────────────────
deploy:
	gcloud builds submit --tag gcr.io/beatbot-35280/beatbot-api
	gcloud run deploy beatbot-api \
		--image gcr.io/beatbot-35280/beatbot-api \
		--region us-east4 \
		--platform managed \
		--allow-unauthenticated \
		--memory 1Gi \
		--min-instances 0 \
		--set-env-vars CORS_EXTRA_ORIGIN=https://beatbot-35280.web.app

.PHONY: deploy

deploy-front:
	cd frontend && npm run build
	cd frontend && firebase deploy --only hosting

.PHONY: deploy-front
	
# ── BeatBot pip package ───────────────────────────────────────────────────────
#
# The CLI is distributed via PyPI (beatbot package), NOT as a zip or binary.
# After changing beatbot/cli.py, beatbot/extractor/, or beatbot/track.py:
#
#   1. Bump version in pyproject.toml
#   2. poetry build
#   3. twine upload dist/*.whl dist/*.tar.gz

publish:
	rm -rf dist/
	poetry build
	/Library/Frameworks/Python.framework/Versions/3.11/bin/python3 -m twine upload dist/*.whl dist/*.tar.gz

.PHONY: publish
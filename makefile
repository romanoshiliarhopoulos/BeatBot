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
#   2. make publish

install-local:
	pip install -e ".[daemon]"
	@echo "BeatBot CLI installed locally. Try running 'beatbot daemon'"

.PHONY: install-local

publish:
	rm -rf dist/
	poetry build
	poetry run twine upload dist/*.whl dist/*.tar.gz

.PHONY: publish
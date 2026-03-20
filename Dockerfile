FROM python:3.13-slim

WORKDIR /app

# System libs required by librosa (soundfile) and audio processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first (layer is cached unless requirements change)
COPY requirements-api.txt .
RUN pip install --no-cache-dir -r requirements-api.txt

# Application source
COPY src/ ./src/

# Bake the latest model weights into the image so Cloud Run needs no
# external storage access at startup.
COPY data/models/ ./data/models/

# Cloud Run injects $PORT (defaults to 8080); single worker is fine for
# personal traffic and keeps memory low inside the free tier.
ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn src.api.main:app --host 0.0.0.0 --port $PORT --workers 1"]

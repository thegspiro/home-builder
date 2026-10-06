# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app/src \
    HEARTBEAT_FILE=/tmp/worker-heartbeat

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY src ./src

# Unprivileged user; code and dependencies stay root-owned and read-only.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin worker
USER worker

# Healthy while the main loop (or a running import) has touched the heartbeat file
# within the last 10 minutes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["python", "-c", "import os, sys, time; p = os.environ['HEARTBEAT_FILE']; sys.exit(0 if os.path.exists(p) and time.time() - os.path.getmtime(p) < 600 else 1)"]

CMD ["python", "-m", "homebuilder_worker"]

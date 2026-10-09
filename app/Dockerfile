FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_MAP_TILE_URL
ARG VITE_MAP_TILE_ATTRIBUTION
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ROADS_DEMO_MODE=false ROADS_REQUIRE_HTTPS=true PHOTO_DIR=/data/uploads
WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt && useradd --uid 10001 --create-home roads && mkdir -p /data/uploads && chown -R roads:roads /data
COPY backend/app ./backend/app
COPY tools/manage_users.py tools/backup.py ./tools/
COPY --from=frontend /build/dist ./frontend/dist
USER roads
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=3)"
# Only expose this container through the private Compose network and Caddy.
CMD ["python","-m","uvicorn","app.main:app","--app-dir","backend","--host","0.0.0.0","--port","8000","--proxy-headers","--forwarded-allow-ips","*"]

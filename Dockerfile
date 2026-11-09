FROM python:3.12-slim
WORKDIR /app
COPY server.py ./
COPY web ./web
COPY pinned ./pinned
ENV HOST=0.0.0.0 TRUST_PROXY=1 BLOCKROOM_CACHE=/tmp/blockroom-cache
EXPOSE 8642
USER nobody
CMD ["python3", "server.py"]

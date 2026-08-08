FROM ubuntu:24.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends g++ python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /judge
COPY server.py .
RUN useradd --system --uid 10001 judge
USER judge
EXPOSE 8080
CMD ["python3", "server.py"]

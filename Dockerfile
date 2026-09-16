# Go 版镜像（goal-39 从 Node 切换）：多阶段构建，运行阶段只带二进制与前端资源
# 构建阶段
FROM golang:1.25-bookworm AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
COPY public ./public
COPY config.example.json ./

RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/mimir ./cmd/mimir

# 运行阶段
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /out/mimir /app/mimir
COPY --from=build /src/public /app/public
COPY config.example.json /app/config.example.json

# 数据/日志目录（与 compose 的卷挂载对应）
RUN mkdir -p /app/data/chats /app/logs /app/audio

ENV TZ=Asia/Shanghai
EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8001/api/status || exit 1

CMD ["/app/mimir", "-root", "/app", "-bot", "-serve"]

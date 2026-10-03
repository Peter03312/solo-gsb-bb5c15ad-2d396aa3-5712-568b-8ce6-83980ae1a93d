# syntax=docker/dockerfile:1

# ---- 依赖构建阶段（better-sqlite3 需要本地编译）----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 编译 better-sqlite3 原生模块所需工具链
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---- 运行阶段 ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 的预编译 .node 二进制在本镜像中已可用；
# 若目标主机架构不同可设置 npm_config_build_from_source 重新编译。
COPY --from=build /app/node_modules ./node_modules
COPY server.js package.json ./
COPY src ./src
COPY public ./public

# 数据持久化目录（SQLite 文件默认 /app/data/drill.db）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3000
ENV DB_PATH=/app/data/drill.db
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# AI-BIM 运行镜像：web 静态资源 + tools/serve.py 服务端（含同源 LLM 代理）
# 服务端只用 Python 标准库，不装任何 pip 包，镜像保持精简。
# BASE_IMAGE 可覆盖：国内构建/拉取受限时改用镜像加速源
# docker build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/python:3.11-alpine .
#
# 用 alpine（musl libc）而不是 slim（Debian 12 / glibc 2.36）：
# glibc 2.34+ 的 pthread_create 走 clone3 系统调用，Docker 20.10.10 以前的默认
# seccomp profile 不放行 clone3，在 Docker 18/19 上会直接 "can't start new thread"，
# 一个工作线程都开不出来。musl 只用传统的 clone，不受此限制。
ARG BASE_IMAGE=python:3.11-alpine
FROM ${BASE_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8823

WORKDIR /app

# 只带运行必需的东西：前端资源 + 服务端脚本
COPY web/                /app/web/
COPY tools/serve.py      /app/tools/serve.py
COPY tools/llm_proxy.py  /app/tools/llm_proxy.py
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

# ASR 离线语音模型不进镜像（体积大且未入库），留空目录供运行时挂载
RUN mkdir -p /app/tools/asr \
    && chmod +x /app/docker-entrypoint.sh \
    && adduser -D -u 10001 app \
    && chown -R app:app /app

USER app

EXPOSE 8823

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8823')+'/',timeout=4).status==200 else 1)"

ENTRYPOINT ["/app/docker-entrypoint.sh"]

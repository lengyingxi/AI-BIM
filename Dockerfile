# AI-BIM 运行镜像：web 静态资源 + tools/serve.py 服务端（含同源 LLM 代理）
# 服务端只用 Python 标准库，不装任何 pip 包，镜像保持精简。
# BASE_IMAGE 可覆盖：国内构建/拉取受限时改用镜像加速源
# docker build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/python:3.11-slim .
ARG BASE_IMAGE=python:3.11-slim
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
    && useradd -m -u 10001 app \
    && chown -R app:app /app

USER app

EXPOSE 8823

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8823')+'/',timeout=4).status==200 else 1)"

ENTRYPOINT ["/app/docker-entrypoint.sh"]

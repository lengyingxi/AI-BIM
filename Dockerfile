# AI-BIM 运行镜像：web 静态资源 + tools/serve.py 服务端（含同源 LLM 代理、离线语音）
#
# 基础镜像固定用 Debian 11（bullseye），不要换成 bookworm/slim：
#   1) glibc 2.31 < 2.34，pthread_create 走传统 clone 系统调用。
#      glibc 2.34+ 改走 clone3，而 Docker 20.10.10 以前的默认 seccomp profile
#      不放行 clone3，在 Docker 18/19 上会 "can't start new thread"，
#      一个工作线程都开不出来，服务起得来但所有请求被掐断。
#   2) sherpa-onnx 只提供 manylinux wheel，musl（alpine）装不上。
#
# BASE_IMAGE 可覆盖：国内构建/拉取受限时改用镜像加速源
#   docker build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/python:3.11-slim-bullseye .
# PIP_INDEX_URL 可覆盖：国内 pip 慢时指定镜像源
ARG BASE_IMAGE=python:3.11-slim-bullseye
FROM ${BASE_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8823

ARG PIP_INDEX_URL=

WORKDIR /app

# 离线语音识别依赖（模型不进镜像，运行时挂载到 /app/tools/asr）
# numpy 必须显式装：sherpa-onnx 2.x 不再自带，而 _sherpa_feed 要用它把
# int16 PCM 转成 float32，缺了会静默返回空文本（表现为"听得见但识别不出字"）
RUN pip install --no-cache-dir ${PIP_INDEX_URL:+--index-url $PIP_INDEX_URL} sherpa-onnx numpy

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

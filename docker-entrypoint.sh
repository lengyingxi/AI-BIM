#!/bin/sh
# 容器启动入口：把环境变量翻译成 tools/serve.py 的命令行参数
set -e

ARGS="--host 0.0.0.0 --port ${PORT:-8823}"

[ -n "${LLM_TARGET:-}" ] && ARGS="$ARGS --target $LLM_TARGET"
[ -n "${LLM_MODEL:-}"  ] && ARGS="$ARGS --model $LLM_MODEL"

# Key 优先用挂载的文件（tools/.llm_key 未入库），其次用环境变量
if [ -f /app/tools/.llm_key ]; then
  ARGS="$ARGS --key-file /app/tools/.llm_key"
elif [ -n "${LLM_KEY:-}" ]; then
  ARGS="$ARGS --key $LLM_KEY"
fi

# 离线语音：挂了模型目录就启用，否则退回浏览器识别
if [ -d "${ASR_MODEL_DIR:-/app/tools/asr}" ] && \
   ls "${ASR_MODEL_DIR:-/app/tools/asr}" 2>/dev/null | grep -q .; then
  ARGS="$ARGS --asr-model ${ASR_MODEL_DIR:-/app/tools/asr}"
else
  ARGS="$ARGS --no-asr"
fi

echo "启动参数：$ARGS"
exec python tools/serve.py $ARGS

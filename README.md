# AI-BIM / AIbim 运维系统TEST

浏览器端的 BIM 运维演示系统：**三维模型浏览 + 自然语言对话操控 + 离线语音指令 + 结构校核**。

整套东西只有一个 Python 进程：`tools/serve.py` 既提供静态页面，又做大模型请求的同源转发（绕开浏览器预检跨域），还负责把麦克风 PCM 在本地转成文字。不装任何 pip 包，Python 标准库就能跑。

演示模型：滨海科创中心 A 座，5 层 / 2574 m² / 55 间房，含结构配筋、机电风管与风阀拓扑、设备库。

---

## 一、功能

| 模块 | 说明 |
| --- | --- |
| 三维场景 | `web/js/scene.js`，Three.js 渲染，数据坐标 x 东 / y 北 / z 上 |
| 结构树 | `web/js/tree.js`，按楼层、房间、构件层级浏览与筛选 |
| 构件属性 | `web/js/detail.js`，选中构件查看与编辑参数 |
| 设备布置 | `web/js/equip.js`，12 类设备库，支持导入布置 |
| IFC 读取 | `web/js/ifc.js`，读取 `web/assets/*.ifc` 换模型 |
| 管线路由 | `web/js/routes.js`，风管路由、关阀查下游影响 |
| 结构校核 | `web/js/calc.js`，板厚 / 配筋 / 活荷载，出单板承载力计算书（GB 50010 口径） |
| 对话智能体 | `web/js/agent.js` + `nlp.js` + `mcp.js`，自然语言指令转工具调用 |
| 离线语音 | `tools/serve.py` 的 `/asr/*`，sherpa-onnx 流式识别，全程不出本机 |

### 服务端接口

| 路径 | 用途 |
| --- | --- |
| `/` | 静态页面（`web/`） |
| `/llm/v1/*` | 大模型同源转发，页面填 `/llm/v1` 即可 |
| `/llm-config` | 页面启动时查询网关与模型是否已配好 |
| `/asr/health`、`/asr/warm` | 离线语音可用性与预热 |
| `/asr/start`、`/asr/chunk`、`/asr/final`、`/asr/cancel`、`/asr/transcribe` | 流式语音识别 |

---

## 二、快速开始

### 方式一：Docker（推荐）

```bash
docker pull registry.cn-hangzhou.aliyuncs.com/lengyingxi/aibim:XXX

docker run -d --name aibim \
  -p 8823:8823 \
  -e LLM_KEY=sk-你的key \
  registry.cn-hangzhou.aliyuncs.com/lengyingxi/aibim:XXX
```

浏览器打开 <http://localhost:8823>。

### 方式二：docker compose

仓库根目录已带 `docker-compose.yml`，把里面的 `XXX` 换成实际镜像版本号后：

```bash
mkdir -p secrets asr
echo 'sk-你的key' > secrets/llm_key

docker compose up -d
docker compose logs -f
```

### 方式三：本机直接跑（开发用）

```bash
python3 tools/serve.py --port 8823          # 只监听 127.0.0.1
python3 tools/serve.py --port 8823 --host 0.0.0.0   # 对外放开
python3 tools/serve.py --key sk-xxx         # Key 放服务端，页面不用填
python3 tools/serve.py --no-asr             # 关闭离线语音，退回浏览器识别
```

常用参数：`--target`（上游地址）、`--model`（模型名）、`--asr-model`（模型目录）、`--timeout`（上游超时秒数）。

---

## 三、配置

容器通过环境变量配置，由 `docker-entrypoint.sh` 转成 `serve.py` 参数：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8823` | 容器内监听端口 |
| `LLM_TARGET` | `https://llmapi.siruijie.com.cn/v1` | 上游大模型地址（含 `/v1`） |
| `LLM_MODEL` | 空 | 模型名，留空由服务启动时自动挑选 |
| `LLM_KEY` | 空 | 上游 Key |
| `ASR_MODEL_DIR` | `/app/tools/asr` | 离线语音模型目录 |

Key 也可以挂载文件（优先于 `LLM_KEY`）：`./secrets/llm_key:/app/tools/.llm_key:ro`。

> 页面里「本地理解 → 本机直连 → 测试连接」可验证网关配置是否生效。服务端没配 Key 时，页面填写的 Key 会原样转发给上游。

---

## 四、离线语音识别（可选）

镜像内不含语音模型（体积大且未入库），按需挂载：

- **sherpa-onnx 流式 zipformer（推荐）**：从 [sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases) 下载 `sherpa-onnx-streaming-zipformer-multi-zh-hans-2023-12-12`（int8，约 70 MB），把 `tokens.txt` 与 `encoder / decoder / joiner` 三个 `.onnx` 放进 `tools/asr/mzh/`
- **vosk 兜底**：`bash tools/getasr.sh` 下载 `vosk-model-small-cn-0.22`

挂载后容器启动时检测到目录非空会自动启用，无需额外参数；目录为空则退回浏览器语音识别。

自检：`python3 tools/asrselftest.py`（需先起服务）。

---

## 五、镜像与自动构建

推送到 `main` 分支后，GitHub Actions（`.github/workflows/docker-publish.yml`）自动构建并推送到阿里云 ACR：

```
registry.cn-hangzhou.aliyuncs.com/lengyingxi/aibim:latest
registry.cn-hangzhou.aliyuncs.com/lengyingxi/aibim:main-<7位sha>
registry.cn-hangzhou.aliyuncs.com/lengyingxi/aibim:<日期>-<sha>
```

ECS 在杭州 VPC 内建议用内网域名 `registry-vpc.cn-hangzhou.aliyuncs.com/...`，免公网流量。

CI 依赖两个仓库 Secret：`ALIYUN_REGISTRY_USERNAME`、`ALIYUN_REGISTRY_PASSWORD`（阿里云容器镜像服务 → 访问凭证 → 固定密码）。

> 阿里云 ACR 个人版不支持 OCI attestation 空清单，workflow 里已关闭 `provenance` 与 `sbom`，不要打开。

---

## 六、目录结构

```
web/                     前端
  index.html             页面入口
  css/app.css
  js/                    scene / tree / detail / equip / ifc / routes / calc
                         agent / nlp / mcp（对话与工具层）
  js/vendor/             Three.js 与 OrbitControls
  data/                  model-data.js（模型数据）、ifc-data.js
  assets/                AIBIM_Haibin_Tower_A.ifc
tools/
  serve.py               服务端：静态服务 + LLM 同源转发 + ASR 接口
  llm_proxy.py           独立 LLM 代理脚本
  getasr.sh              vosk 中文模型下载
  asrselftest.py         离线语音自检
  *.js                   开发期的截图 / 端到端调试脚本
docs/                    模型信息差距清单、离线语音部署说明
outputs/                 调试截图产物（已 gitignore）
```

---

## 七、开发说明

- 前端是纯静态资源，改完刷新即可，无需构建
- `tools/*.js` 是开发期用的截图与端到端脚本，产物落在 `outputs/`，两者都不入库
- 镜像只打包 `web/`、`tools/serve.py`、`tools/llm_proxy.py` 和启动脚本，`.dockerignore` 排除了 `outputs/`、`tools/asr` 与调试脚本
- 密钥文件 `tools/.llm_key` 已在 `.gitignore` 中，切勿提交

---

## 八、相关文档

- `docs/离线语音识别部署说明.md` —— 引擎选型、装到干净机器、换模型、排错
- `docs/本模型 vs 传统 BIM 运维模型：信息差距与补全清单.md` —— 模型资产维度现状与补全方向

## 许可

见 [LICENSE](./LICENSE)。

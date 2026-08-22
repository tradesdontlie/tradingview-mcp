# ML TP/SL 概率预测子系统

独立于 `dashboard-server.js` 的子系统，预测"未来一段时间内先触及止盈还是先触及止损"的概率。完整背景见 [`.claude/plans/soft-mapping-emerson.md`](../.claude/plans/soft-mapping-emerson.md)（本机路径，未提交进仓库）。

## 已知限制

- **Replay 抓取速度**：1h/4h 一次跑几分钟能覆盖 1-2 年；1m/5m 单品种拉 30-45 天可能要跑数小时（无批量历史 API，只能逐bar走）。
- **没有真正的宏观日历**：`config/sessions.json` 里的 `fomc_dates` 默认是空的，需要你去 [federalreserve.gov](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm) 手动填。NFP 用"每月第一个周五 08:30 ET"规则自动算，不需要手填。
- **这是决策辅助，不自动下单**——环境里没有接入真实券商。

## 安装

```bash
pip3 install -r ml/requirements.txt
```

## 使用流程（在仓库根目录，`cd tradingview-mcp` 下执行）

### 1. 确认/修改 TP/SL 参数

编辑 `ml/config/symbols.json`——里面的数值是占位默认值，训练前务必核对成你真正想用的止盈止损点数。

### 2. 抓历史数据（需要 TradingView Desktop 打开、CDP 端口 9222 可连）

```bash
python3 ml/data_collection/collect_replay.py --symbol MNQ1! --timeframe 60 --days 5   # 冒烟测试：先拉一个小窗口
python3 ml/data_collection/collect_replay.py --symbol MNQ1! --timeframe 60 --days 730 # 1h 全量历史
python3 ml/data_collection/collect_replay.py --symbol MNQ1! --timeframe 1 --days 30   # 1m 近30天
```

原始数据写到 `~/data/ml-raw/{symbol}_{timeframe}.parquet`。断点续跑/加宽窗口不需要单独的checkpoint文件——脚本每次都会读一下磁盘上已有数据的最早/最晚日期，和这次请求的目标窗口对比，只补真正缺的那一段（更早的历史缺口、更新的日期缺口，或两者都缺）。所以中断后重跑同一条命令，或者事后把 `--days` 从 5 改成 730，都会自动补齐缺口，不会重新从头抓，也不会像之前那样因为已经有一点数据就误判"已经抓完"。

### 3. 构建特征+标签数据集

```bash
python3 -m ml.features.build_dataset --symbol MNQ1! --timeframe 1 --context 5,60
```

输出到 `~/data/ml-processed/{symbol}_{timeframe}.parquet`。

### 4. 训练模型（多空各训一个）

```bash
python3 -m ml.train.train_model --symbol MNQ1! --timeframe 1 --direction long
python3 -m ml.train.train_model --symbol MNQ1! --timeframe 1 --direction short
python3 -m ml.train.evaluate --symbol MNQ1! --timeframe 1 --direction long
```

模型存到 `ml/models/`（已加入 `.gitignore`，不提交）。

### 5. 启动实时预测服务

```bash
node ml/serve/server.js
```

默认监听 `http://localhost:4600`，`GET /api/predictions` 返回当前所有已配置品种×周期的预测缓存；前端页面在同一端口根路径。轮询目标自动从 `symbols.json` 里的品种×周期组合生成，且严格顺序执行（同一张图表一次只能被一个 predict.py 操作，不能并行）。

## 目录结构

```
config/       symbols.json (TP/SL/预测窗口), sessions.json (时段+宏观日期)
data_collection/  collect_replay.py — replay驱动的历史抓取，按磁盘已有数据自动补缺口
features/     indicators.py / liquidity_sweep.py / session_context.py / build_dataset.py
labels/       triple_barrier.py — 固定ticks的三重界限标签
train/        train_model.py (LightGBM, 按时间切分, 不shuffle) / evaluate.py (校准曲线)
models/       训练好的模型 (gitignored)
serve/        predict.py (实时推理) / live_agent.js (轮询缓存) / server.js (Express) / public/ (前端)
```

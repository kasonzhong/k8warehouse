#!/bin/bash
cd "$(dirname "$0")"
PORT=8080
echo "K8 批量退货处理系统正在启动..."
echo "浏览器地址：http://localhost:${PORT}"
python3 -m http.server ${PORT}

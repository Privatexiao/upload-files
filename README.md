# 介绍
批量文件上传
# 技术架构
vue2 + vue-cli + axios + element ui + Web Worker + localforage(用来断点上传，也可以改为后端处理好一点)
搭配node.js + express 使用
# 文件说明
后端项目：node-server    启动命令：npm run dev:v2
前端项目：v2-file-upload   启动命令：npm run dev
# 使用说明
1.文件拉取下来后，先安装所需依赖 npm i
2.node >= 14
# 功能说明
支持 大文件【断点、暂停、恢复、秒传】
后端功能：切片上传、合并切片、秒传验证、删除文件、文件列表。

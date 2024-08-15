const express = require('express')
const app = express()
const port = 3000
const path = require('path')
const fse = require('fs-extra')
const multiparty = require('multiparty')

app.use((req, res, next) => {
  // 请求头允许跨域
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  next()
})

app.options('*', (req, res) => {
  res.sendStatus(200)
})

app.listen(port, () => console.log('v2基础大文件上传：监听3000端口'))

// 大文件存储目录
const UPLOAD_DIR = path.resolve(__dirname, 'target')

// 创建临时文件夹用于临时存储 所有的文件切片
const getChunkDir = (fileHash) => {
  // 添加 chunkCache 前缀与文件名做区分
  // target/chunkCache_fileHash值
  return path.resolve(UPLOAD_DIR, `chunkCache_${fileHash}`)
}

// 处理切片上传
app.post('/upload', async (req, res) => {
  try {
    // 处理文件表单
    const form = new multiparty.Form()
    form.parse(req, async (err, fields, files) => {
      if (err) {
        res.send({
          code: -1,
          msg: '单片上传失败',
          data: err
        })
        return false
      }
      // fields是body参数
      // 文件hash ，切片hash ，文件名
      const {
        fileHash,
        chunkHash,
        fileName
      } = fields
      // files是传过来的文件所在的真实路径以及内容
      const {
        chunkFile
      } = files

      // 创建一个临时文件目录用于 临时存储所有文件切片
      const chunkCache = getChunkDir(fileHash)

      // 检查 chunkDir临时文件目录 是否存在，如果不存在则创建它。
      if (!fse.existsSync(chunkCache)) {
        await fse.mkdirs(chunkCache)
      }

      //   将上传的文件切片移动到指定的存储文件目录
      //  fse.move 方法默认不会覆盖已经存在的文件。
      //   将 overwrite: true 设置为 true，这样当目标文件已经存在时，将会被覆盖。
      //   把上传的文件移动到 /target/chunkCache_ + chunkHash
      await fse.move(chunkFile[0].path, `${chunkCache}/${chunkHash}`, {
        overwrite: true,
      })
      res.send({
        code: 0,
        msg: '单片上传完成',
        data: {
          fileHash,
          chunkHash,
          fileName
        },
      })
    })
  } catch (errB) {
    res.send({
      code: -1,
      msg: '单片上传失败',
      data: errB
    })
  }
})

// 处理请求参数
const resolvePost = (req) => {
  // 所有接收到的数据块拼接成一个字符串，然后解析为 JSON 对象。
  return new Promise((resolve, reject) => {
    let body = [] // 使用数组而不是字符串来避免大字符串的内存问题
    // 监听请求对象 req 的 data 事件。每当有数据块传输过来时，处理程序就会被调用。
    req.on('data', (data) => {
      // 假设数据是 Buffer，将其追加到数组中
      body.push(data)
    })
    // 监听请求对象 req 的 end 事件。当所有数据块接收完毕时
    req.on('end', () => {
      // 使用 Buffer.concat 将所有数据块合并为一个 Buffer
      const buffer = Buffer.concat(body)
      // 将 Buffer 转换为字符串（假设是 UTF-8 编码）
      const stringData = buffer.toString('utf8')
      try {
        // 尝试解析 JSON 字符串
        const parsedData = JSON.parse(stringData)
        // 如果解析成功，则 resolve
        resolve(parsedData)
      } catch (error) {
        // 如果解析失败，则 reject
        reject(new Error('参数解析失败'))
      }
      // 可以添加一个 'error' 事件监听器来处理任何可能出现的错误
      req.on('error', (error) => {
        reject(error)
      })
    })
  })
}

// 把文件切片写成总的一个文件流
const pipeStream = (path, writeStream) => {
  return new Promise((resolve, reject) => {
    // 创建可读流
    const readStream = fse.createReadStream(path).on('error', (err) => {
      // 如果在读取过程中发生错误，拒绝 Promise
      reject(err)
    })
    // 在一个指定位置写入文件流
    readStream.pipe(writeStream).on('finish', () => {
      // 写入完成后，删除原切片文件
      fse.unlinkSync(path)
      resolve()
    }).on('error', (err) => {
      reject(err);
    });
  })
}

// 合并切片
const mergeFileChunk = async (chunkSize, fileHash, filePath) => {
  try {
    // target/chunkCache_fileHash值
    const chunkCache = getChunkDir(fileHash)
    // 读取 临时所有切片目录 chunkCache 下的所有文件和子目录，并返回这些文件和子目录的名称。
    const chunkPaths = await fse.readdir(chunkCache)

    // 根据切片下标进行排序
    // 否则直接读取目录的获得的顺序会错乱
    chunkPaths.sort((a, b) => a.split('-')[1] - b.split('-')[1])

    let promiseList = []
    const queue = []; // 创建一个队列来处理文件块
    let openIndex = 0; // 打开的文件数

    // 控制并发度// 同时处理的最大文件块数量（不同的系统打开的文件数有限制，出现报文件打开过多，可调小一点）此字段决定合并速度
    const maxConcurrency = 1000;


    for (let index = 0; index < chunkPaths.length; index++) {
      // target/chunkCache_hash值/文件切片位置
      let chunkPath = path.resolve(chunkCache, chunkPaths[index])
      // 根据 index * chunkSize 在指定位置创建可写流
      // let writeStream = fse.createWriteStream(filePath, {
      //   start: index * chunkSize,
      // })
      // promiseList.push(pipeStream(chunkPath, writeStream))

      queue.push(async () => {
        const writeStream = fse.createWriteStream(filePath, {
          start: index * chunkSize,
        });
        // 已打开要写入的文件事件
        writeStream.on('open', (fd) => {
          // console.log('文件已打开:', fd);
          openIndex++
        });
        await pipeStream(chunkPath, writeStream);
      });
    }
    // 逐批处理队列中的任务
    for (let i = 0; i < queue.length; i += maxConcurrency) {
      // 获取当前批次的任务
      const batch = queue.slice(i, i + maxConcurrency);
      // 等待当前批次的任务全部完成
      await Promise.all(batch.map(task => task()))
    }
    // 打开数量和任务一样，全部合并完了删除缓存目录
    if (openIndex == queue.length) {
      if (fse.pathExistsSync(chunkCache)) {
        fse.remove(chunkCache)
        console.log(`chunkCache缓存目录删除成功`)
        return Promise.resolve()
      } else {
        console.log(`${chunkCache} 不存在，不能删除`)
        return Promise.reject(`${chunkCache} 不存在，不能删除`)
      }
    }


    // 使用 Promise.all 等待所有 Promise 完成
    // (相当于等待所有的切片已写入完成且删除了所有的切片文件)
    // Promise.all(promiseList)
    //   .then(() => {
    //     console.log('所有文件切片已成功处理并删除')
    //     // 在这里执行所有切片处理完成后的操作
    //     // 递归删除缓存切片目录及其内容 (注意，如果删除不存在的内容会报错)
    //     if (fse.pathExistsSync(chunkCache)) {
    //       fse.remove(chunkCache)
    //       console.log(`chunkCache缓存目录删除成功`)
    //       // 合并成功，返回 Promise.resolve
    //       return Promise.resolve()
    //     } else {
    //       console.log(`${chunkCache} 不存在，不能删除`)

    //       return Promise.reject(`${chunkCache} 不存在，不能删除`)
    //     }
    //   })
    //   .catch((err) => {
    //     console.error('文件处理过程中发生错误：', err)
    //     // 在这里处理错误，可能需要清理资源等
    //     return Promise.reject(`'文件处理过程中发生错误：${err}`)
    //   })
  } catch (err) {
    console.log(err, '合并切片函数失败')
    return Promise.reject(`'合并切片函数失败：${err}`)
  }
}

// 提取文件后缀名
const extractExt = (fileName) => {
  // 查找'.'在fileName中最后出现的位置
  const lastIndex = fileName.lastIndexOf('.')
  // 如果'.'不存在，则返回空字符串
  if (lastIndex === -1) {
    return ''
  }
  // 否则，返回从'.'后一个字符到fileName末尾的子串作为文件后缀（包含'.'）
  return fileName.slice(lastIndex)
}

// 合并接口
app.post('/merge', async (req, res) => {
  // 在上传完所有切片后就要调合并切片
  try {
    // 处理所有参数
    const data = await resolvePost(req)
    // 切片大小 文件名 文件hash
    const {
      chunkSize,
      fileName,
      fileHash
    } = data
    // 提取文件后缀名
    const ext = extractExt(fileName)
    // 整个文件路径 /target/文件hash.文件后缀
    const filePath = path.resolve(UPLOAD_DIR, `${fileHash}${ext}`)
    // 使用原来文件名
    // const filePath = path.resolve(UPLOAD_DIR, `${fileName}`)
    // 开始合并切片
    await mergeFileChunk(chunkSize, fileHash, filePath)
    res.send({
      code: 0,
      msg: '文件合并成功',
    })
  } catch (err) {
    res.send({
      code: -1,
      data: err,
      msg: '文件合并失败！',
    })
  }
})

// 返回已上传的所有切片名
const createUploadedList = async (fileHash) => {
  // 如果存在这个目录则返回这个目录下的所有切片
  // fse.readdir返回一个数组，其中包含指定目录中的文件名。
  return fse.existsSync(getChunkDir(fileHash)) ?
    await fse.readdir(getChunkDir(fileHash)) : []
}

// 验证是否存在已上传切片
app.post('/verify', async (req, res) => {
  try {
    const data = await resolvePost(req)
    const {
      fileHash,
      fileName
    } = data

    // 文件名后缀
    const ext = extractExt(fileName)
    // 最终文件路径
    const filePath = path.resolve(UPLOAD_DIR, `${fileHash}${ext}`)
    // const filePath = path.resolve(UPLOAD_DIR, `${fileName}`)

    // 如果已经存在文件则标识文件已存在，不需要再上传
    if (fse.existsSync(filePath)) {
      res.send({
        code: 0,
        data: {
          shouldUpload: false,
          uploadedList: [],
        },
        msg: '已存在该文件',
      })
    } else {
      // 否则则返回文件已经存在切片给前端
      // 告诉前端这些切片不需要再上传
      res.send({
        code: 0,
        data: {
          shouldUpload: true,
          uploadedList: await createUploadedList(fileHash),
        },
        msg: '需要上传文件/部分切片',
      })
    }
  } catch (err) {
    res.send({
      code: -1,
      msg: '上传失败',
      data: err
    })
  }
})


// 删除本地文件
app.post('/delete', async (req, res) => {
  try {
    // 处理所有参数
    const data = await resolvePost(req)
    const {
      fileHash,
      fileName
    } = data

    // 文件名后缀
    const ext = extractExt(fileName)
    // 最终文件路径
    const filePath = path.resolve(UPLOAD_DIR, `${fileHash}${ext}`)
    fse.remove(filePath, (err) => {
      if (err) throw '删除失败'
      res.send({
        code: 0,
        msg: '文件删除成功',
      })
    });
  } catch (err) {
    res.send({
      code: -1,
      msg: '删除失败'
    })
  }
})

const formatTimestampToDateTime = (timestamp) => {
  // 创建 Date 对象
  const date = new Date(parseInt(timestamp));

  // 获取年月日时分秒
  const year = date.getFullYear();
  const month = ('0' + (date.getMonth() + 1)).slice(-2); // 月份是从 0 开始的，所以加 1
  const day = ('0' + date.getDate()).slice(-2);
  const hours = ('0' + date.getHours()).slice(-2);
  const minutes = ('0' + date.getMinutes()).slice(-2);
  const seconds = ('0' + date.getSeconds()).slice(-2);

  // 组合日期和时间
  const formattedDateTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

  return formattedDateTime;
}

// 获取已上传文件列表
app.get('/filesList', async (req, res) => {
  try {
    // 读取上传目录中的所有文件
    const files = await fse.readdir(UPLOAD_DIR);
    // 过滤掉非文件项（例如目录）并收集文件元数据
    const fileList = await Promise.all(files.map(async file => {
      const filePath = path.join(UPLOAD_DIR, file);
      const stats = await fse.stat(filePath);
      if (stats.isFile()) {
        let name = ''
        let hash = ''
        let size = ''
        // 去掉md5前缀
        if (file.length > 16) {
          if (file.length > 32) {
            name = file.substring(32);
            hash = file.substring(0, 32);
          } else {
            name = file.substring(16);
            hash = file.substring(0, 16);
          }
        }
        if ((stats.size / 1024 / 1024) > 1024) {
          size = (stats.size / 1024 / 1024 / 1024).toFixed(2) + 'G';
        } else {
          size = (stats.size / 1024 / 1024).toFixed(2) + 'M';
        }

        return {
          name: name,
          fileHash: hash,
          fileHashName: file,
          size: size,
          creation_time: formatTimestampToDateTime(parseInt(stats.birthtimeMs)), // 创建时间
          edit_time: formatTimestampToDateTime(parseInt(stats.ctimeMs)), //修改时间
        };
      }
      return null;
    }));

    // 过滤掉 null 值
    const validFiles = fileList.filter(Boolean);

    res.send({
      code: 0,
      msg: '获取文件列表成功',
      data: validFiles,
    });
  } catch (err) {
    res.send({
      code: -1,
      msg: '获取文件列表失败',
      data: err,
    });
  }
});
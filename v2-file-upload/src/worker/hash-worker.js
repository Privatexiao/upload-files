import SparkMD5 from './spark-md5.min.js'
// 创建文件切片
function createFileChunk(file, chunkSize) {
  return new Promise((resolve, reject) => {
    let fileChunkList = []
    let cur = 0
    while (cur < file.size) {
      // Blob 接口的 slice() 方法创建并返回一个新的 Blob 对象，该对象包含调用它的 blob 的子集中的数据。
      fileChunkList.push({ chunkFile: file.slice(cur, cur + chunkSize) })
      cur += chunkSize
    }
    // 返回全部文件切片
    resolve(fileChunkList)
  })
}

// 加载并计算文件切片的MD5(方式1)【速度慢】
// async function calculateChunksHash(fileChunkList) {
//   // 初始化脚本
//   const spark = new SparkMD5.ArrayBuffer()

//   // 计算切片进度（拓展功能，可自行添加）
//   let percentage = 0
//   // 计算切片次数
//   let count = 0

//   // 递归函数，用于处理文件切片
//   async function loadNext(index) {
//     if (index >= fileChunkList.length) {
//       // 所有切片都已处理完毕
//       return spark.end() // 返回最终的MD5值
//     }

//     return new Promise((resolve, reject) => {
//       const reader = new FileReader()
//       reader.readAsArrayBuffer(fileChunkList[index].chunkFile)
//       reader.onload = (e) => {
//         count++
//         spark.append(e.target.result)
        
//         // 只有文件切片数量大于300时，才更新进度
//         if(fileChunkList.length > 300){
//           // 更新进度并处理下一个切片
//           percentage += 100 / fileChunkList.length
//         }
//         self.postMessage({ percentage }) // 发送进度到主线程

//         resolve(loadNext(index + 1)) // 递归调用，处理下一个切片
//       }
//       reader.onerror = (err) => {
//         reject(err) // 如果读取错误，则拒绝Promise
//       }
//     })
//   }

//   try {
//     // 开始计算切片
//     const fileHash = await loadNext(0) // 等待所有切片处理完毕
//     self.postMessage({ percentage: 100, fileHash, fileChunkList }) // 发送最终结果到主线程
//     self.close() // 关闭Worker
//   } catch (err) {
//     self.postMessage({ name: 'error', data: err }) // 发送错误到主线程
//     self.close() // 关闭Worker
//   }
// }
// 加载并计算文件切片的MD5(方式2)【速度快】
async function calculateChunksHash(fileChunkList) {
  // 初始化脚本
  const spark = new SparkMD5.ArrayBuffer()

  // 计算切片进度（拓展功能，可自行添加）
  let percentage = 0
  // 计算切片次数
  let count = 0
  
  // 使用队列控制并发读取切片
  const queue = [];
  // 控制同时读取切片的最大数量
  const maxConcurrency  = 10; 

  async function processQueue() {
    while (queue.length > 0) {
      const item = queue.shift();
      const { index } = item;
      const reader = new FileReader();
      reader.readAsArrayBuffer(fileChunkList[index].chunkFile);
      reader.onload = (e) => {
        spark.append(e.target.result);
        count++;
        processQueue(); // 继续处理队列中的下一个任务
      };
      reader.onerror = (err) => {
        self.postMessage({ name: 'error', data: err }); // 发送错误到主线程
        self.close(); // 关闭Worker
      };
    }
  }

  // 将读取操作放入队列
  for (let i = 0; i < fileChunkList.length; i++) {
    if (queue.length < maxConcurrency) {
      queue.push({ index: i });
      processQueue();
    }
  }

  // 等待所有读取操作完成
  await new Promise((resolve) => {
    const intervalId = setInterval(() => {
      if (queue.length === 0) {
        clearInterval(intervalId);
        resolve(spark.end());
      }
    }, 100);
  });

  self.postMessage({ percentage: 100, fileHash: spark.end(), fileChunkList }); // 发送最终结果到主线程
  self.close(); // 关闭Worker
}

// 监听消息
self.addEventListener(
  'message',
  async (e) => {
    try {
      const { file, chunkSize } = e.data
      const fileChunkList = await createFileChunk(file, chunkSize) // 创建文件切片
      await calculateChunksHash(fileChunkList) // 等待计算完成
    } catch (err) {
      // 这里实际上不会捕获到calculateChunksHash中的错误，因为错误已经在Worker内部处理了
      // 但如果未来有其他的异步操作，这里可以捕获到它们
      console.error('worker监听发生错误:', err)
    }
  },
  false
)

// 主线程可以监听 Worker 是否发生错误。如果发生错误，Worker 会触发主线程的error事件。
self.addEventListener('error', function (event) {
  console.log('Worker触发主线程的error事件：', event)
  self.close() // 关闭Worker
})
